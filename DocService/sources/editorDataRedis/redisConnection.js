/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const redis = require('redis');
const operationContext = require('./../../../Common/sources/operationContext');
const {toRedisString} = require('./redisValueCodec');

const REDIS_LOG_PREFIX = '[editorDataRedis]';
const REDIS_UNAVAILABLE_CODE = 'REDIS_UNAVAILABLE';
const {
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS,
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
} = require('./redisConfig');

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

class RedisConnection {
  constructor(database) {
    this.database = database;
    this.client = null;
    this.connectPromise = null;
    this.connector = null;
    this.cluster = false;
    this.sentinel = false;
    this.connectionAttempted = false;
    this.lastError = null;
    this.commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.activeOperations = 0;
    this.idleWaiters = [];
  }

  _createClient() {
    if (this.closing) {
      throw new RedisUnavailableError(new Error('Redis connection is closing'));
    }
    if (cfgRedisName !== 'redis') {
      log('error', 'unsupported Redis connector configured: %s', cfgRedisName);
      throw new Error(`Unsupported Redis connector: ${cfgRedisName}`);
    }
    this.connector = 'redis';
    this.cluster = hasNodeCluster();
    this.sentinel = hasNodeSentinel();
    if (this.cluster && this.sentinel) {
      throw new Error('Redis Cluster and Redis Sentinel options cannot be enabled together');
    }
    if (this.sentinel) {
      this.client = redis.createSentinel(normalizeSentinelOptions(cfgRedisOptionsSentinel, this.database));
    } else if (this.cluster) {
      if (this.database !== undefined && this.database !== null && Number(this.database) !== 0) {
        log('error', 'Redis Cluster cannot use logical database %s; configure database 0', this.database);
        throw new Error('Redis Cluster does not support a non-zero logical database');
      }
      this.client = redis.createCluster(normalizeClusterOptions(cfgRedisOptionsCluster));
    } else {
      this.client = redis.createClient(normalizeNodeOptions(cfgRedisOptions, this.database));
    }
    this.closed = false;
    log(
      'debug',
      'created %s client (cluster=%s, host=%s, port=%s, database=%s)',
      this.connector,
      this.cluster,
      cfgRedisHost,
      cfgRedisPort,
      this.database ?? 0
    );
    this.client.on('error', error => {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log('error', 'client error (connector=%s, cluster=%s): %s', this.connector, this.cluster, errorDetails(error));
    });
    this.client.on('reconnecting', details => log('warn', 'client reconnecting (connector=%s): %j', this.connector, details || {}));
    this.client.on('ready', () => {
      this.lastError = null;
      log('debug', 'client ready (connector=%s, cluster=%s, sentinel=%s)', this.connector, this.cluster, this.sentinel);
    });
    this.client.on('end', () => {
      log('warn', 'client connection ended (connector=%s, cluster=%s, sentinel=%s)', this.connector, this.cluster, this.sentinel);
    });
  }

  async connect() {
    return this._withOperation(() => this._connect());
  }

  async _connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.isConnected()) {
      return;
    }
    if (this.sentinel && this.client && this.connectionAttempted && !this.client.isOpen) {
      this._abortClient();
    }
    if (!this.client) {
      this._createClient();
    }
    const currentClient = this.client;
    if (this.sentinel && this.connectionAttempted && currentClient.isOpen && !currentClient.isReady) {
      throw new RedisUnavailableError(this.lastError);
    }
    const startedAt = Date.now();
    log(
      'debug',
      'connect start (connector=%s, status=%s, open=%s, ready=%s)',
      this.connector,
      currentClient.status || 'n/a',
      currentClient.isOpen ?? 'n/a',
      currentClient.isReady ?? 'n/a'
    );
    this.connectionAttempted = true;
    this.connectPromise = (async () => {
      if (!currentClient.isOpen) {
        await withTimeout(currentClient.connect(), REDIS_CONNECT_TIMEOUT_MS, 'Redis connect');
      }
      if (!currentClient.isReady) {
        await waitForReady(currentClient, this.connector, REDIS_CONNECT_TIMEOUT_MS);
      }
    })();
    try {
      await this.connectPromise;
      log('debug', 'connect ready after %dms (connector=%s)', Date.now() - startedAt, this.connector);
    } catch (error) {
      log(
        'error',
        'connect failed after %dms (connector=%s, host=%s, port=%s, database=%s): %s',
        Date.now() - startedAt,
        this.connector,
        cfgRedisHost,
        cfgRedisPort,
        this.database ?? 0,
        errorDetails(error)
      );
      await this._closeClient();
      this.closed = true;
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  isConnected() {
    if (this.closed || !this.client) {
      return false;
    }
    return Boolean(this.client.isReady ?? this.client.isOpen);
  }

  async command(args) {
    return this._withOperation(async () => {
      await this._connect();
      const normalized = args.map(toRedisString);
      const commandName = normalized[0] ? normalized[0].toUpperCase() : 'UNKNOWN';
      const startedAt = Date.now();
      log('debug', 'command start %s (keys=%d)', commandName, Math.max(0, normalized.length - 1));
      try {
        let result;
        if (this.cluster) {
          const command = normalized[0].toUpperCase();
          const firstKey = command === 'EVAL' ? normalized[3] : command === 'PING' ? undefined : normalized[1];
          result = this.client.sendCommand(firstKey, false, normalized);
        } else if (this.sentinel) {
          result = this.client.sendCommand(false, normalized);
        } else {
          result = this.client.sendCommand(normalized);
        }
        result = await this._withCommandTimeout(result, `Redis command ${commandName}`);
        log('debug', 'command end %s after %dms', commandName, Date.now() - startedAt);
        return result;
      } catch (error) {
        log('error', 'command failed %s after %dms (connector=%s): %s', commandName, Date.now() - startedAt, this.connector, errorDetails(error));
        throw error;
      }
    });
  }

  async commands(commands) {
    return this._withOperation(async () => {
      if (this.cluster) {
        return Promise.all(commands.map(command => this.command(command)));
      }
      await this._connect();
      const multi = this.client.multi();
      for (const args of commands) {
        const normalized = args.map(toRedisString);
        multi.addCommand(...(this.sentinel ? [false, normalized] : [normalized]));
      }
      return this._withCommandTimeout(multi.exec(), `Redis transaction with ${commands.length} commands`);
    });
  }

  async eval(script, keys, args) {
    return this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
  }

  async close() {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.closed && !this.client) {
      return;
    }
    this.closing = true;
    this.closePromise = (async () => {
      await this._waitForIdle();
      await this._closeClient();
      this.closed = true;
      this.closing = false;
    })();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  async _closeClient() {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    this.connectionAttempted = false;
    this.lastError = null;
    if (!client || !client.isOpen) {
      return;
    }
    try {
      log('debug', 'closing redis client');
      const close =
        typeof client.close === 'function' ? client.close.bind(client) : typeof client.quit === 'function' ? client.quit.bind(client) : null;
      if (close) {
        await withTimeout(Promise.resolve().then(close), 5000, 'Redis close');
      } else {
        throw new Error('Redis client has no close method');
      }
    } catch (error) {
      log('warn', 'graceful Redis close failed; forcing disconnect: %s', errorDetails(error));
      if (typeof client.destroy === 'function') {
        client.destroy();
      } else if (typeof client.disconnect === 'function') {
        client.disconnect();
      }
    }
  }

  _withOperation(operation) {
    if (this.closing || this.closed) {
      return Promise.reject(new RedisUnavailableError(new Error('Redis connection is closed')));
    }
    this.activeOperations++;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.activeOperations--;
        if (this.activeOperations === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          waiters.forEach(resolve => resolve());
        }
      });
  }

  _waitForIdle() {
    if (this.activeOperations === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  _abortClient() {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    this.connectionAttempted = false;
    this.lastError = null;
    if (!client || !client.isOpen) {
      return;
    }
    if (typeof client.destroy === 'function') {
      client.destroy();
    } else if (typeof client.disconnect === 'function') {
      client.disconnect();
    }
  }

  async _withCommandTimeout(promise, description) {
    try {
      return await withTimeout(promise, this.commandTimeoutMs, description);
    } catch (error) {
      if (error.code === 'ETIMEDOUT') {
        this._abortClient();
      }
      throw error;
    }
  }
}

module.exports = {
  RedisConnection,
  normalizeNodeOptions,
  normalizeClusterOptions,
  normalizeSentinelOptions,
  sentinelReconnectStrategy,
  RedisUnavailableError,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS,
  REDIS_UNAVAILABLE_CODE
};
