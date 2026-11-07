/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');

const REDIS_CONNECT_TIMEOUT_MS = 15000;
const REDIS_COMMAND_TIMEOUT_MS = 30000;
// editorDataRedis consumes RESP2 array replies; node-redis 6 defaults to RESP3.
const REDIS_RESP_VERSION = 2;
const REDIS_SENTINEL_RECONNECT_MAX_RETRIES = 5;
const REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS = 250;
const REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS = 2000;
const REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH = 256;
const REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES = 3;
// Keep command rediscovery disabled because the command may have committed
// before its response was lost. Initial discovery retries are handled by the
// Redis connection wrapper with a fresh Sentinel client instead.
const REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS = 0;

const cfgRedis = config.get('services.CoAuthoring.redis');
const cfgRedisName = cfgRedis.get('name');
const cfgRedisHost = cfgRedis.get('host');
const cfgRedisPort = cfgRedis.get('port');
const cfgRedisOptions = cfgRedis.get('options');
const cfgRedisOptionsCluster = cfgRedis.get('optionsCluster');
const cfgRedisOptionsSentinel = cfgRedis.has('optionsSentinel') ? cfgRedis.get('optionsSentinel') : {};

function cloneConfig(value) {
  if (config.util && config.util.cloneDeep) {
    return config.util.cloneDeep(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeCommandOptions(source) {
  const options = cloneConfig(source) || {};
  if (options.timeout === undefined) {
    options.timeout = REDIS_COMMAND_TIMEOUT_MS;
  }
  return options;
}

function hasControlCharacters(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

module.exports = {
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_RESP_VERSION,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS,
  cfgRedisName,
  cfgRedisHost,
  cfgRedisPort,
  cfgRedisOptions,
  cfgRedisOptionsCluster,
  cfgRedisOptionsSentinel,
  cloneConfig,
  normalizeCommandOptions,
  hasControlCharacters
};
