/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const cron = require('cron');
const ms = require('ms');

const EXPIRY_SAFETY_MARGIN_RATIO = 0.1;
// setTimeout runs a longer delay after 1 ms instead (with a warning), which
// would turn a schedule such as "0 0 0 31 2 *" into a busy loop.
const MAX_TIMER_DELAY_MS = 2147483647;
// The default.json values: documentsCron "0 */2 * * * *", filesCron "00 00 */1 * * *".
const DEFAULT_DOCUMENTS_CRON_STEP_MS = 120000;
const DEFAULT_FILES_CRON_STEP_MS = 3600000;

function getCronStep(cronTime) {
  const cronJob = new cron.CronJob(cronTime, () => {});
  const dates = cronJob.nextDates(2);
  return dates[1] - dates[0];
}

// The interval of a cron setting that the AdminPanel can change (its schema
// only checks for six fields). An expression that cannot be parsed, or gives no
// positive interval, falls back to fallbackMs, and an interval longer than a
// timer allows is shortened, so neither stops DocService from starting nor
// makes a timer fire every millisecond. message explains a replacement.
function cronStepMs(cronTime, name, fallbackMs, getStep = getCronStep) {
  let stepMs;
  let problem;
  try {
    stepMs = getStep(cronTime);
  } catch (error) {
    problem = `Invalid ${name}: ${error.message}`;
  }
  if (!problem && (!Number.isFinite(stepMs) || stepMs <= 0)) {
    problem = `${name} must produce a positive interval`;
  }
  if (problem) {
    return {stepMs: fallbackMs, message: `${problem}. Using the default interval of ${fallbackMs / 1000} seconds instead.`};
  }
  if (stepMs > MAX_TIMER_DELAY_MS) {
    return {
      stepMs: MAX_TIMER_DELAY_MS,
      message: `${name} runs every ${Math.ceil(stepMs / 1000)} seconds, longer than a timer allows. Using ${MAX_TIMER_DELAY_MS / 1000} seconds instead.`
    };
  }
  return {stepMs};
}

function ttlMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.ceil(value * 1000) : NaN;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.ceil(numeric * 1000);
    }

    const parsed = ms(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.ceil(parsed);
    }
  }

  return NaN;
}

function invalidConfiguration(message, details = {}) {
  return {
    valid: false,
    message,
    ...details
  };
}

// The documentsCron/TTL rule protects keys that expire on their own in
// Redis/Valkey: editor-data presence and editor-stat shard counters. The
// in-memory backend keeps neither, so it accepts any documentsCron, as before.
function documentExpiryTtlsApply(editorDataStorage, editorStatStorage) {
  return [editorDataStorage, editorStatStorage || editorDataStorage].some(storage => storage !== 'editorDataMemory');
}

function validateDocumentExpiryConfig(expire, getStep = getCronStep, {checkTtls = true} = {}) {
  const documentsCron = expire?.documentsCron;

  let documentsCronStepMs;
  try {
    documentsCronStepMs = getStep(documentsCron);
  } catch (error) {
    return invalidConfiguration(`Invalid services.CoAuthoring.expire.documentsCron: ${error.message}`);
  }

  if (!Number.isFinite(documentsCronStepMs) || documentsCronStepMs <= 0) {
    return invalidConfiguration('services.CoAuthoring.expire.documentsCron must produce a positive interval');
  }
  if (!checkTtls) {
    return {valid: true, documentsCronStepMs};
  }

  const presenceTtlMs = ttlMilliseconds(expire?.presence);
  const shardTtlMs = ttlMilliseconds(expire?.shard);
  if (!Number.isFinite(presenceTtlMs) || !Number.isFinite(shardTtlMs)) {
    return invalidConfiguration('services.CoAuthoring.expire.presence and services.CoAuthoring.expire.shard must be positive durations');
  }

  const minimumTtlMs = Math.max(documentsCronStepMs * (1 + EXPIRY_SAFETY_MARGIN_RATIO), documentsCronStepMs + 1000);
  if (minimumTtlMs >= presenceTtlMs || minimumTtlMs >= shardTtlMs) {
    return invalidConfiguration(
      `services.CoAuthoring.expire.documentsCron runs every ${Math.ceil(documentsCronStepMs / 1000)} seconds, but ` +
        `presence TTL is ${Math.ceil(presenceTtlMs / 1000)} seconds and shard TTL is ${Math.ceil(shardTtlMs / 1000)} seconds. ` +
        'The documentsCron interval must be shorter than both the presence and shard TTLs with scheduling headroom.',
      {documentsCronStepMs, presenceTtlMs, shardTtlMs}
    );
  }

  return {valid: true, documentsCronStepMs, presenceTtlMs, shardTtlMs};
}

function passesTtlRule(stepMs, ttlMs) {
  return Math.max(stepMs * (1 + EXPIRY_SAFETY_MARGIN_RATIO), stepMs + 1000) < ttlMs;
}

// The interval used instead of one that is too slow for the TTLs: the default
// interval, or half the shorter TTL when that is shorter. Unlike the longest
// interval that passes the rule, this leaves room for the time each refresh
// pass itself takes. NaN when the TTLs are too short for any interval of at
// least one second.
function safeDocumentsStepMs(presenceTtlMs, shardTtlMs) {
  const ttlMs = Math.min(presenceTtlMs, shardTtlMs);
  const stepMs = Math.min(DEFAULT_DOCUMENTS_CRON_STEP_MS, Math.floor(ttlMs / 2));
  return stepMs >= 1000 && passesTtlRule(stepMs, ttlMs) ? stepMs : NaN;
}

// Like validateDocumentExpiryConfig, but a documentsCron that is only too slow
// for the TTLs does not fail: the interval is shortened (see
// safeDocumentsStepMs; `clamped`, with `message` for the log). documentsCron is editable in the
// AdminPanel and only sets this interval, so a slow value must not stop
// DocService from starting or GC from running; an invalid one uses the default
// interval (see cronStepMs). Only unusable TTLs still fail.
function resolveDocumentExpiryStep(expire, getStep = getCronStep, options = {}) {
  const cronStep = cronStepMs(expire?.documentsCron, 'services.CoAuthoring.expire.documentsCron', DEFAULT_DOCUMENTS_CRON_STEP_MS, getStep);
  const validation = validateDocumentExpiryConfig(expire, () => cronStep.stepMs, options);
  if (validation.valid) {
    return cronStep.message
      ? {...validation, stepMs: cronStep.stepMs, clamped: true, message: cronStep.message}
      : {...validation, stepMs: validation.documentsCronStepMs, clamped: false};
  }
  if (!Number.isFinite(validation.documentsCronStepMs)) {
    return validation;
  }
  const stepMs = safeDocumentsStepMs(validation.presenceTtlMs, validation.shardTtlMs);
  if (!Number.isFinite(stepMs)) {
    return validation;
  }
  return {
    valid: true,
    clamped: true,
    stepMs,
    documentsCronStepMs: validation.documentsCronStepMs,
    presenceTtlMs: validation.presenceTtlMs,
    shardTtlMs: validation.shardTtlMs,
    message: `${cronStep.message ? `${cronStep.message} ` : ''}${validation.message} Using an interval of ${stepMs / 1000} seconds instead.`
  };
}

// The interval DocService really refreshes presence and connection statistics
// at: gc.js sets it at startup, and it can be shorter than documentsCron (see
// resolveDocumentExpiryStep). /info groups the statistics samples by it.
let documentsExpireStepMs;

function setDocumentsExpireStepMs(stepMs) {
  documentsExpireStepMs = stepMs;
}

function getDocumentsExpireStepMs() {
  return documentsExpireStepMs;
}

// The shortest presence or connection shard TTL, in seconds, for a tenant or
// runtime value: twice the refresh interval, so that a refresh pass that takes
// a while still renews entries before they expire. undefined until gc.js has
// set the interval.
function minimumRefreshedTtlSeconds() {
  if (!Number.isFinite(documentsExpireStepMs) || documentsExpireStepMs <= 0) {
    return undefined;
  }
  return Math.ceil((2 * documentsExpireStepMs) / 1000);
}

// The document expiry interval for the startup configuration (a `config`
// module), as gc.js resolves it. Lets a process that does not run gc.js, such
// as the AdminPanel, group statistics by the interval DocService really uses.
function documentExpiryFromConfig(config) {
  const get = (path, fallback) => (config.has(path) ? config.get(path) : fallback);
  const checkTtls = documentExpiryTtlsApply(
    get('services.CoAuthoring.server.editorDataStorage', 'editorDataMemory'),
    get('services.CoAuthoring.server.editorStatStorage', '')
  );
  return resolveDocumentExpiryStep(
    {
      documentsCron: get('services.CoAuthoring.expire.documentsCron'),
      presence: get('services.CoAuthoring.expire.presence'),
      shard: get('services.CoAuthoring.expire.shard', 300)
    },
    undefined,
    {checkTtls}
  );
}

module.exports = {
  DEFAULT_DOCUMENTS_CRON_STEP_MS,
  DEFAULT_FILES_CRON_STEP_MS,
  MAX_TIMER_DELAY_MS,
  cronStepMs,
  documentExpiryFromConfig,
  documentExpiryTtlsApply,
  getCronStep,
  getDocumentsExpireStepMs,
  minimumRefreshedTtlSeconds,
  resolveDocumentExpiryStep,
  safeDocumentsStepMs,
  setDocumentsExpireStepMs,
  ttlMilliseconds,
  validateDocumentExpiryConfig
};
