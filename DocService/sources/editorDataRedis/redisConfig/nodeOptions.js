/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_RESP_VERSION,
  cfgRedisHost,
  cfgRedisPort,
  cloneConfig,
  normalizeCommandOptions,
  normalizeTimeoutMs,
  hasControlCharacters
} = require('./base');

function normalizeSentinelName(value) {
  if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value) || hasControlCharacters(value)) {
    throw new Error('Redis Sentinel requires optionsSentinel.name to be a non-empty name without whitespace or control characters');
  }
  return value;
}

function normalizeSentinelRootNode(node, index) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`Redis Sentinel optionsSentinel.sentinelRootNodes[${index}] must be an object`);
  }
  if (typeof node.host !== 'string' || node.host.trim() === '' || /\s/.test(node.host) || hasControlCharacters(node.host)) {
    throw new Error(`Redis Sentinel optionsSentinel.sentinelRootNodes[${index}].host must be a non-empty host name`);
  }
  const port = Number(node.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Redis Sentinel optionsSentinel.sentinelRootNodes[${index}].port must be an integer between 1 and 65535`);
  }
  return {host: node.host.trim(), port};
}

// Resolve the legacy `user`/`db` aliases of one options layer. Callers that
// merge layers resolve each layer first, so an alias in a more specific layer
// overrides the canonical key it inherits from a less specific one.
function resolveOptionAliases(source) {
  const options = {...(source || {})};
  if (options.user !== undefined && options.username === undefined) {
    options.username = options.user;
  }
  if (options.db !== undefined && options.database === undefined) {
    options.database = options.db;
  }
  delete options.user;
  delete options.db;
  return options;
}

// node-redis retries a failed connect forever by default, so a refused
// connection failed only at the adapter's connect deadline
// (REDIS_CONNECT_TIMEOUT_MS), and that deadline destroyed the client in the
// middle of an attempt (an attempt that completed later left a connection
// behind). The standalone client gives up after a few quick retries instead;
// RedisConnection creates a new client for the next operation.
const STANDALONE_RECONNECT_MAX_RETRIES = 5;
function standaloneReconnectStrategy(retries, cause) {
  if (retries >= STANDALONE_RECONNECT_MAX_RETRIES) {
    return cause instanceof Error ? cause : new Error('Redis reconnect attempts exhausted');
  }
  return Math.min(2 ** retries * 50, 1000) + Math.floor(Math.random() * 100);
}

function normalizeNodeOptions(source, database, includeEndpoint = true, includeCommandOptions = true) {
  const options = resolveOptionAliases(cloneConfig(source));
  options.RESP = REDIS_RESP_VERSION;
  if (includeEndpoint) {
    options.disableOfflineQueue = true;
  }
  // An unquoted value in a templated config ("password": 12345) would make
  // every handshake throw a TypeError that startup reports only as a timeout.
  for (const name of ['username', 'password']) {
    if (typeof options[name] === 'number') {
      options[name] = String(options[name]);
    }
  }
  if (options.username === '') {
    // An empty username is no username (node-redis treats it the same).
    delete options.username;
  }
  if (options.password === '') {
    delete options.password;
    // Older entrypoints emitted the implicit default ACL username together
    // with an empty password. Treat that combination as unauthenticated.
    if (options.username === 'default') {
      delete options.username;
    }
  }
  if (options.username !== undefined && (options.password === undefined || options.password === null)) {
    throw new Error('Redis authentication requires a password when a username is configured');
  }
  if (options.database !== undefined && options.database !== null && options.database !== '') {
    options.database = Number(options.database);
  }
  if (database !== undefined && database !== null && database !== '') {
    options.database = Number(database);
  }
  // Number('abc') is NaN, which node-redis silently treats as database 0.
  if (
    options.database !== undefined &&
    options.database !== null &&
    options.database !== '' &&
    !(Number.isInteger(options.database) && options.database >= 0)
  ) {
    throw new Error(`Redis database must be a non-negative integer; received ${JSON.stringify(source?.database ?? source?.db ?? database)}`);
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
    options.socket.connectTimeout = normalizeTimeoutMs(options.socket.connectTimeout, 'socket.connectTimeout', REDIS_CONNECT_TIMEOUT_MS);
  }
  if (includeEndpoint) {
    options.socket = options.socket || {};
    if (options.socket.reconnectStrategy === undefined) {
      options.socket.reconnectStrategy = standaloneReconnectStrategy;
    }
  }
  return options;
}

module.exports = {normalizeNodeOptions, normalizeSentinelName, normalizeSentinelRootNode, resolveOptionAliases, standaloneReconnectStrategy};
