/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const cron = require('cron');
const ms = require('ms');

const EXPIRY_SAFETY_MARGIN_RATIO = 0.1;

function getCronStep(cronTime) {
  const cronJob = new cron.CronJob(cronTime, () => {});
  const dates = cronJob.nextDates(2);
  return dates[1] - dates[0];
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

function validateDocumentExpiryConfig(expire, getStep = getCronStep) {
  const documentsCron = expire?.documentsCron;
  const presenceTtlMs = ttlMilliseconds(expire?.presence);
  const shardTtlMs = ttlMilliseconds(expire?.shard);

  let documentsCronStepMs;
  try {
    documentsCronStepMs = getStep(documentsCron);
  } catch (error) {
    return invalidConfiguration(`Invalid services.CoAuthoring.expire.documentsCron: ${error.message}`);
  }

  if (!Number.isFinite(documentsCronStepMs) || documentsCronStepMs <= 0) {
    return invalidConfiguration('services.CoAuthoring.expire.documentsCron must produce a positive interval');
  }
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

module.exports = {
  getCronStep,
  ttlMilliseconds,
  validateDocumentExpiryConfig
};
