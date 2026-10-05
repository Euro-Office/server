/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {
  REDIS_RESP_VERSION,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS,
  REDIS_CONNECT_TIMEOUT_MS,
  cfgRedisOptions,
  cfgRedisOptionsSentinel,
  cloneConfig,
  normalizeCommandOptions
} = require('./base');
const {normalizeNodeOptions, normalizeSentinelName, normalizeSentinelRootNode} = require('./nodeOptions');

function sentinelReconnectStrategy(retries) {
  if (retries >= REDIS_SENTINEL_RECONNECT_MAX_RETRIES) {
    return false;
  }
  return Math.min(REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS * 2 ** retries, REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS);
}

function normalizeSentinelOptions(source, database) {
  const options = cloneConfig(source) || {};
  options.RESP = REDIS_RESP_VERSION;
  options.name = normalizeSentinelName(options.name);
  if (!Array.isArray(options.sentinelRootNodes) || options.sentinelRootNodes.length === 0) {
    throw new Error('Redis Sentinel requires optionsSentinel.sentinelRootNodes');
  }
  options.sentinelRootNodes = options.sentinelRootNodes.map(normalizeSentinelRootNode);
  const sentinelNodes = new Set(options.sentinelRootNodes.map(node => `${node.host}:${node.port}`));
  if (sentinelNodes.size !== options.sentinelRootNodes.length) {
    throw new Error('Redis Sentinel optionsSentinel.sentinelRootNodes must not contain duplicate nodes');
  }
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
  // Keep one master client reserved for the Sentinel object. Without this,
  // node-redis leases the default one-client pool for every command, which
  // serializes unrelated editor-data, statistics, and notification work.
  options.reserveClient = true;
  options.commandOptions = normalizeCommandOptions(options.commandOptions);
  // Do not let the native Sentinel client replay commands after a lost reply.
  // Initial discovery retries are handled by RedisConnection with a fresh
  // client and one overall connection budget.
  options.maxCommandRediscovers = REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS;
  options.passthroughClientErrorEvents = true;
  return options;
}

function hasNodeSentinel() {
  const options = cloneConfig(cfgRedisOptionsSentinel) || {};
  return Object.keys(options).length > 0;
}

module.exports = {normalizeSentinelOptions, sentinelReconnectStrategy, hasNodeSentinel};
