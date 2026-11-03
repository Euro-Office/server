/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const util = require('util');
const constants = require('../constants');

const SECRETS = [
  [/(\b(?:access_token|token|doc)=)[^&#\s"'\\]*/gi, '$1[Filtered]'],
  [/("authorization"\s*:\s*")[^"]*/gi, '$1[Filtered]'],
  [/(Bearer\s+)[^\s"'\\]+/gi, '$1[Filtered]'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[Filtered]']
];

let Sentry = null;

/**
 * Initializes the Sentry SDK when SENTRY_DSN is set. Must run before any other require so the SDK can instrument modules.
 * @param {string} service - process name, reported as the `service` tag
 */
function init(service) {
  if (!process.env.SENTRY_DSN || Sentry) {
    return;
  }
  Sentry = require('@sentry/node');
  const {buildVersion} = require('../commondefines');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE || `documentserver@${buildVersion}`,
    sendDefaultPii: false,
    initialScope: {tags: {service}},
    // Crashes are reported through the existing uncaughtException handlers, which log the error and flush via logger.shutdown
    integrations: defaults => defaults.filter(i => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection'),
    beforeSend: scrub
  });
}

function isEnabled() {
  return Sentry !== null;
}

function scrub(event) {
  if (event.request) {
    const {method, url, query_string} = event.request;
    event.request = {method, url, query_string};
  }
  const json = SECRETS.reduce((str, [pattern, replacement]) => str.replace(pattern, replacement), JSON.stringify(event));
  return JSON.parse(json);
}

/**
 * log4js appender module: reports events of level ERROR and above.
 */
function configure(config, layouts, findAppender, levels) {
  const appender = logEvent => {
    if (!logEvent.level.isGreaterThanOrEqualTo(levels.ERROR)) {
      return;
    }
    const [template] = logEvent.data;
    const error = logEvent.data.find(arg => arg instanceof Error);
    const stack = logEvent.data.find(arg => typeof arg === 'string' && /\n\s+at /.test(arg));
    const message = util.format(...logEvent.data);
    const {TENANT, DOCID, USERID, REFERENCEDATA, FILENAME} = logEvent.context || {};
    const context = {
      level: logEvent.level.isGreaterThanOrEqualTo(levels.FATAL) ? 'fatal' : 'error',
      tags: {logger: logEvent.categoryName},
      extra: {message}
    };
    if (TENANT) {
      context.tags.tenant = TENANT;
    }
    if (DOCID && DOCID !== constants.DEFAULT_DOC_ID) {
      context.tags.docId = DOCID;
    }
    for (const [key, value] of Object.entries(REFERENCEDATA || {})) {
      context.tags[`referenceData.${key}`] = value;
    }
    if (process.env.SENTRY_SEND_PII === 'true') {
      if (USERID && USERID !== constants.DEFAULT_USER_ID) {
        context.user = {id: USERID};
      }
      if (FILENAME) {
        context.extra.fileName = FILENAME;
      }
    }
    if (typeof template === 'string') {
      context.fingerprint = error ? [template, '{{ default }}'] : stack ? [template, stack.split('\n')[0]] : [template];
    }
    if (error) {
      Sentry.captureException(error, context);
    } else {
      Sentry.captureMessage(message, context);
    }
  };
  // log4js also calls shutdown on every reconfigure, so flush rather than close the client
  appender.shutdown = done => Sentry.flush(2000).then(() => done(), done);
  return appender;
}

module.exports = {name: 'sentry', init, isEnabled, scrub, configure};
