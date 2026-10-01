/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

// Backends are required statically so pkg bundles them
const backends = [require('./sentry')];

/**
 * Initializes all configured error reporting backends. Must run before any other require so backends can instrument modules.
 * @param {string} service - process name, e.g. docservice or converter
 */
function init(service) {
  backends.forEach(backend => backend.init(service));
}

/**
 * @returns {object} log4js appenders of the enabled backends, keyed by backend name
 */
function appenders() {
  return Object.fromEntries(backends.filter(backend => backend.isEnabled()).map(backend => [backend.name, {type: backend}]));
}

module.exports = {init, appenders};
