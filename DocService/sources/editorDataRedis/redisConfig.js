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
const REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS = 0;

const cfgRedis = config.get('services.CoAuthoring.redis');
const cfgRedisName = cfgRedis.get('name');
const cfgRedisHost = cfgRedis.get('host');
const cfgRedisPort = cfgRedis.get('port');
const cfgRedisOptions = cfgRedis.get('options');
const cfgRedisOptionsCluster = cfgRedis.get('optionsCluster');
const cfgRedisOptionsSentinel = cfgRedis.get('optionsSentinel');

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

function sentinelReconnectStrategy(retries) {
  if (retries >= REDIS_SENTINEL_RECONNECT_MAX_RETRIES) {
    return false;
  }
  return Math.min(REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS * 2 ** retries, REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS);
}

function normalizeNodeOptions(source, database, includeEndpoint = true, includeCommandOptions = true) {
  const options = cloneConfig(source) || {};
  options.RESP = REDIS_RESP_VERSION;
  if (options.user !== undefined && options.username === undefined) {
    options.username = options.user;
  }
  if (options.db !== undefined && options.database === undefined) {
    options.database = options.db;
  }
  delete options.user;
  delete options.db;
  if (options.database !== undefined && options.database !== null && options.database !== '') {
    options.database = Number(options.database);
  }
  if (database !== undefined && database !== null && database !== '') {
    options.database = Number(database);
  }
  if (includeCommandOptions) {
    options.commandOptions = normalizeCommandOptions(options.commandOptions);
  }
  if (!options.url) {
    options.socket = options.socket || {};
    if (includeEndpoint && options.socket.host === undefined) {
      options.socket.host = cfgRedisHost;
    }
    if (includeEndpoint && options.socket.port === undefined) {
      options.socket.port = Number(cfgRedisPort);
    }
    if (!includeEndpoint) {
      delete options.socket.host;
      delete options.socket.port;
    }
    if (options.socket.connectTimeout === undefined) {
      options.socket.connectTimeout = REDIS_CONNECT_TIMEOUT_MS;
    }
  }
  return options;
}

function normalizeClusterOptions(source) {
  const options = cloneConfig(source) || {};
  options.defaults = normalizeNodeOptions(options.defaults || {}, undefined, false, false);
  delete options.defaults.RESP;
  delete options.defaults.database;
  delete options.defaults.commandOptions;
  options.commandOptions = normalizeCommandOptions(options.commandOptions);
  options.RESP = REDIS_RESP_VERSION;
  return options;
}

function normalizeSentinelOptions(source, database) {
  const options = cloneConfig(source) || {};
  options.RESP = REDIS_RESP_VERSION;
  if (!options.name) {
    throw new Error('Redis Sentinel requires optionsSentinel.name');
  }
  if (!Array.isArray(options.sentinelRootNodes) || options.sentinelRootNodes.length === 0) {
    throw new Error('Redis Sentinel requires optionsSentinel.sentinelRootNodes');
  }
  options.sentinelRootNodes = options.sentinelRootNodes.map(node => ({...node, port: Number(node.port)}));
  const nodeDatabase = database ?? options.database;
  delete options.database;
  options.nodeClientOptions = normalizeNodeOptions(
    {...cloneConfig(cfgRedisOptions), ...(options.nodeClientOptions || {})},
    nodeDatabase,
    false,
    false
  );
  delete options.nodeClientOptions.url;
  delete options.nodeClientOptions.commandOptions;
  options.nodeClientOptions.socket = options.nodeClientOptions.socket || {};
  options.nodeClientOptions.socket.connectTimeout ??= REDIS_CONNECT_TIMEOUT_MS;
  options.nodeClientOptions.disableOfflineQueue = true;
  options.nodeClientOptions.commandsQueueMaxLength = REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH;
  options.nodeClientOptions.socket.reconnectStrategy = sentinelReconnectStrategy;
  options.sentinelClientOptions = normalizeNodeOptions(options.sentinelClientOptions || {}, undefined, false, false);
  delete options.sentinelClientOptions.url;
  delete options.sentinelClientOptions.commandOptions;
  options.sentinelClientOptions.socket = options.sentinelClientOptions.socket || {};
  options.sentinelClientOptions.socket.connectTimeout ??= REDIS_CONNECT_TIMEOUT_MS;
  options.sentinelClientOptions.disableOfflineQueue = true;
  options.sentinelClientOptions.commandsQueueMaxLength = REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH;
  // Native Sentinel intentionally uses one-shot clients for Sentinel discovery;
  // its topology loop reconnects through the configured root-node list instead.
  options.sentinelClientOptions.socket.reconnectStrategy = false;
  options.commandOptions = normalizeCommandOptions(options.commandOptions);
  // A command that lost its reply may already have committed. Do not let the
  // native Sentinel client replay it while rediscovering the master.
  options.maxCommandRediscovers = REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS;
  options.passthroughClientErrorEvents = true;
  return options;
}

function hasNodeCluster() {
  const options = cloneConfig(cfgRedisOptionsCluster) || {};
  return Array.isArray(options.rootNodes) && options.rootNodes.length > 0;
}

function hasNodeSentinel() {
  const options = cloneConfig(cfgRedisOptionsSentinel) || {};
  return Object.keys(options).length > 0;
}

module.exports = {
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_RESP_VERSION,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS,
  cfgRedisName,
  cfgRedisHost,
  cfgRedisPort,
  cfgRedisOptions,
  cfgRedisOptionsCluster,
  cfgRedisOptionsSentinel,
  normalizeNodeOptions,
  normalizeClusterOptions,
  normalizeSentinelOptions,
  sentinelReconnectStrategy,
  hasNodeCluster,
  hasNodeSentinel
};
