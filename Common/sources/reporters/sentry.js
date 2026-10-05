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
    const message = util.format(...logEvent.data);
    const {TENANT, DOCID} = logEvent.context || {};
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
    if (typeof template === 'string') {
      context.fingerprint = error ? [template, '{{ default }}'] : [template];
    }
    if (error) {
      Sentry.captureException(error, context);
    } else {
      Sentry.captureMessage(message, context);
    }
  };
  appender.shutdown = done => Sentry.close(2000).then(() => done(), done);
  return appender;
}

module.exports = {name: 'sentry', init, isEnabled, scrub, configure};
