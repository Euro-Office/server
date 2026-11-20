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

// The connect() promise of each client while it connects (see trackConnect).
const pendingConnects = new WeakMap();

function trackConnect(client, promise) {
  const settled = promise.then(
    () => undefined,
    () => undefined
  );
  pendingConnects.set(client, settled);
  settled.then(() => {
    if (pendingConnects.get(client) === settled) {
      pendingConnects.delete(client);
    }
  });
  return promise;
}

// Releases a client that is no longer used. node-redis cannot destroy a client
// while its connect creates the socket (a TCP or TLS handshake in progress):
// the socket is still used when it is ready, the client becomes ready, and
// destroy() is refused from then on, leaving an open connection that keeps the
// process alive. Such a client is destroyed once its connect has settled (it
// fails by itself through connectTimeout or its reconnect strategy), or after
// REDIS_CONNECT_TIMEOUT_MS at the latest (then its socket exists and destroy()
// works, for a server that accepts the connection but never answers).
// waitForConnect false destroys at once: a Sentinel client stuck behind a
// Sentinel that never answers has its socket, and the next attempt must not
// wait for it.
function releaseClient(client, {waitForConnect = true} = {}) {
  if (!client?.isOpen) {
    return;
  }
  const pending = waitForConnect && client.isReady === false ? pendingConnects.get(client) : undefined;
  if (!pending) {
    destroyClient(client);
    return;
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(timer);
    if (client.isOpen) {
      destroyClient(client);
    }
  };
  const timer = setTimeout(release, REDIS_CONNECT_TIMEOUT_MS + 1000);
  timer.unref?.();
  pending.then(release);
}

// Whether a node answers PING within timeoutMs, checked with a client of our
// own that is always closed afterwards (node-redis cannot close its own
// connection to a node that accepts it but never answers). clientOptions
// include the node's address (socket.host/port or url).
async function probeNode(clientOptions, timeoutMs, label) {
  // node-redis throws on a negative connectTimeout after it has opened the
  // socket, whose later error then has no listener and stops the process.
  const timeout = Math.max(1, Math.floor(Number(timeoutMs) || 0));
  const client = redis.createClient({
    ...clientOptions,
    socket: {...clientOptions.socket, connectTimeout: timeout, reconnectStrategy: false}
  });
  client.on('error', () => {});
  try {
    await withTimeout(
      client.connect().then(() => client.sendCommand(['PING'])),
      timeout,
      `Redis ${label} check`
    );
    return true;
  } catch (error) {
    log('warn', '%s did not answer the check: %s', label, errorDetails(error));
    return false;
  } finally {
    // A client whose connect failed has already closed its socket.
    if (client.isOpen) {
      destroyClient(client);
    }
  }
}

function probeSentinel(node, sentinelClientOptions, timeoutMs) {
  return probeNode(
    {...sentinelClientOptions, socket: {...sentinelClientOptions.socket, host: node.host, port: node.port}},
    timeoutMs,
    `Sentinel ${node.host}:${node.port}`
  );
}

// The host:port of a node URL for logs, without the credentials it may carry.
function urlHost(url) {
  try {
    return new URL(url).host;
  } catch (_e) {
    return '(invalid URL)';
  }
}

// A Cluster root node gets the client defaults (credentials, TLS) with its own
// address, as node-redis connects to it for discovery.
function probeClusterRootNode(node, defaults, timeoutMs) {
  const options = {...defaults, ...node, socket: {...defaults?.socket, ...node?.socket}};
  const label = `Cluster root node ${node?.url ? urlHost(node.url) : `${node?.socket?.host}:${node?.socket?.port}`}`;
  return probeNode(options, timeoutMs, label);
}

function createConnectCancelledError() {
  return new RedisUnavailableError(new Error('Redis connect was cancelled'));
}

// Settles like promise, or rejects as soon as signal aborts.
function untilAborted(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createConnectCancelledError());
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(createConnectCancelledError());
    signal.addEventListener('abort', onAbort, {once: true});
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
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
  releaseClient,
  trackConnect,
  probeSentinel,
  probeClusterRootNode,
  urlHost,
  createConnectCancelledError,
  untilAborted,
  RedisUnavailableError
};
