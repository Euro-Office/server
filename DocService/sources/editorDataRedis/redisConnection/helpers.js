/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const operationContext = require('./../../../../Common/sources/operationContext');
const redis = require('redis');
const {ClientOfflineError} = require('@redis/client/dist/lib/errors');
const {REDIS_CONNECT_TIMEOUT_MS} = require('../redisConfig');

const REDIS_LOG_PREFIX = '[editorDataRedis]';
const REDIS_UNAVAILABLE_CODE = 'REDIS_UNAVAILABLE';

function getLogger() {
  return operationContext.global && operationContext.global.logger ? operationContext.global.logger : console;
}

function log(level, message, ...args) {
  try {
    const logger = getLogger();
    const method = typeof logger[level] === 'function' ? logger[level] : logger.error;
    method.call(logger, `${REDIS_LOG_PREFIX} ${message}`, ...args);
  } catch (_e) {
    // Logging must never prevent Redis cleanup or recovery.
  }
}

function errorDetails(error) {
  if (!error) {
    return 'unknown error';
  }
  return error.stack || `${error.name || 'Error'}: ${error.message || String(error)}`;
}

class RedisUnavailableError extends Error {
  constructor(cause) {
    super('Redis is unavailable', cause === undefined ? undefined : {cause});
    this.name = 'RedisUnavailableError';
    this.code = REDIS_UNAVAILABLE_CODE;
  }
}

function createSentinelClient(options) {
  const client = redis.createSentinel(options);
  const targets = new Set([client, client._self]);
  targets.forEach(target => {
    const execute = target._execute.bind(target);
    target._execute = (...args) => {
      if (!client.isReady) {
        return Promise.reject(new ClientOfflineError());
      }
      return execute(...args);
    };
  });
  return client;
}

function withTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${description} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForReady(client, connector, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onReady = () => finish(null);
    const onEnd = () => finish(new Error(`Redis ${connector} connection ended before becoming ready`));
    const onError = error => finish(error instanceof Error ? error : new Error(String(error)));
    const timer = setTimeout(() => finish(new Error(`Redis ${connector} did not become ready within ${timeoutMs}ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener('ready', onReady);
      client.removeListener('end', onEnd);
      client.removeListener('error', onError);
    };
    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }
    client.once('ready', onReady);
    client.once('end', onEnd);
    client.once('error', onError);
  });
}

function createConnectTimeoutError() {
  const error = new Error(`Redis connect timed out after ${REDIS_CONNECT_TIMEOUT_MS}ms`);
  error.code = 'ETIMEDOUT';
  return error;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Releases a client at once. node-redis rejects destroy() once close() has
// started (ClientClosedError), and Sentinel's destroy() is async: neither may
// fail a shutdown or become an unhandled rejection.
function destroyClient(client) {
  try {
    let result;
    if (typeof client.destroy === 'function') {
      result = client.destroy();
    } else if (typeof client.disconnect === 'function') {
      result = client.disconnect();
    }
    Promise.resolve(result).catch(error => log('warn', 'Redis client destroy failed: %s', errorDetails(error)));
  } catch (error) {
    log('warn', 'Redis client destroy failed: %s', errorDetails(error));
  }
}

// Whether a Sentinel answers PING within timeoutMs, checked with a client of
// our own that is always closed afterwards (node-redis cannot close its own
// connection to a Sentinel that accepts it but never answers).
async function probeSentinel(node, sentinelClientOptions, timeoutMs) {
  const client = redis.createClient({
    ...sentinelClientOptions,
    socket: {...sentinelClientOptions.socket, host: node.host, port: node.port, connectTimeout: timeoutMs, reconnectStrategy: false}
  });
  client.on('error', () => {});
  try {
    await withTimeout(
      client.connect().then(() => client.sendCommand(['PING'])),
      timeoutMs,
      'Redis Sentinel check'
    );
    return true;
  } catch (error) {
    log('warn', 'Sentinel %s:%s did not answer the check: %s', node.host, node.port, errorDetails(error));
    return false;
  } finally {
    destroyClient(client);
  }
}

module.exports = {
  REDIS_UNAVAILABLE_CODE,
  log,
  errorDetails,
  createSentinelClient,
  withTimeout,
  waitForReady,
  createConnectTimeoutError,
  wait,
  destroyClient,
  probeSentinel,
  RedisUnavailableError
};
