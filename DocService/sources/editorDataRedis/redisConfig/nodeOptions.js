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

function normalizeNodeOptions(source, database, includeEndpoint = true, includeCommandOptions = true) {
  const options = cloneConfig(source) || {};
  options.RESP = REDIS_RESP_VERSION;
  if (includeEndpoint) {
    options.disableOfflineQueue = true;
  }
  if (options.user !== undefined && options.username === undefined) {
    options.username = options.user;
  }
  if (options.db !== undefined && options.database === undefined) {
    options.database = options.db;
  }
  delete options.user;
  delete options.db;
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

module.exports = {normalizeNodeOptions, normalizeSentinelName, normalizeSentinelRootNode};
