/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {
  REDIS_RESP_VERSION,
  cfgRedisOptionsCluster,
  cloneConfig,
  normalizeCommandOptions
} = require('./base');
const {normalizeNodeOptions} = require('./nodeOptions');

function normalizeClusterOptions(source) {
  const options = cloneConfig(source) || {};
  options.defaults = normalizeNodeOptions(options.defaults || {}, undefined, false, false);
  options.defaults.disableOfflineQueue = true;
  delete options.defaults.RESP;
  delete options.defaults.database;
  delete options.defaults.commandOptions;
  options.commandOptions = normalizeCommandOptions(options.commandOptions);
  options.RESP = REDIS_RESP_VERSION;
  return options;
}

function hasNodeCluster() {
  const options = cloneConfig(cfgRedisOptionsCluster) || {};
  return Array.isArray(options.rootNodes) && options.rootNodes.length > 0;
}

module.exports = {normalizeClusterOptions, hasNodeCluster};
