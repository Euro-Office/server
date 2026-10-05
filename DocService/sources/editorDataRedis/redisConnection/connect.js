/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const redis = require('redis');
const {
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  cfgRedisName,
  cfgRedisHost,
  cfgRedisPort,
  cfgRedisOptions,
  cfgRedisOptionsCluster,
  cfgRedisOptionsSentinel,
  normalizeNodeOptions,
  normalizeClusterOptions,
  normalizeSentinelOptions,
  hasNodeCluster,
  hasNodeSentinel
} = require('../redisConfig');
const {
  log,
  errorDetails,
  createSentinelClient,
  withTimeout,
  waitForReady,
  createConnectTimeoutError,
  wait,
  RedisUnavailableError
} = require('./helpers');

module.exports = function attachConnect(RedisConnection) {
  RedisConnection.prototype._createClient = function () {
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
    let client;
    if (this.sentinel) {
      client = createSentinelClient(normalizeSentinelOptions(cfgRedisOptionsSentinel, this.database));
    } else if (this.cluster) {
      if (this.database !== undefined && this.database !== null && Number(this.database) !== 0) {
        log('error', 'Redis Cluster cannot use logical database %s; configure database 0', this.database);
        throw new Error('Redis Cluster does not support a non-zero logical database');
      }
      client = redis.createCluster(normalizeClusterOptions(cfgRedisOptionsCluster));
    } else {
      client = redis.createClient(normalizeNodeOptions(cfgRedisOptions, this.database));
    }
    this.client = client;
    this.clientGeneration++;
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
  };

  RedisConnection.prototype.connect = async function () {
    await this._withOperation(() => this._connect());
  };

  RedisConnection.prototype._connect = async function () {
    if (this.connectPromise) {
      await this.connectPromise;
      return this._getClientSnapshot();
    }
    if (this.isConnected()) {
      return this._getClientSnapshot();
    }
    if (this.client && this.connectionAttempted && !this.client.isOpen) {
      this._abortClient();
    }
    if (!this.client) {
      this._createClient();
    }
    const currentClient = this.client;
    if (this.connectionAttempted && currentClient.isOpen && !currentClient.isReady) {
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
    const connectPromise = this._connectWithRetries(startedAt);
    this.connectPromise = connectPromise;
    try {
      const connectedClient = await connectPromise;
      log('debug', 'connect ready after %dms (connector=%s)', Date.now() - startedAt, this.connector);
      return this._getClientSnapshot(connectedClient);
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
      await this._closeClient(currentClient);
      throw error;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  };

  RedisConnection.prototype._connectWithRetries = async function (startedAt) {
    let retries = 0;
    while (true) {
      if (this.closing || this.closed) {
        throw new RedisUnavailableError(new Error('Redis connection is closing'));
      }
      if (!this.client) {
        this._createClient();
      }
      const currentClient = this.client;
      this.connectionAttempted = true;
      const remaining = REDIS_CONNECT_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        throw createConnectTimeoutError();
      }
      try {
        if (!currentClient.isOpen) {
          await withTimeout(currentClient.connect(), remaining, 'Redis connect');
        }
        if (!currentClient.isReady) {
          const readyTimeout = REDIS_CONNECT_TIMEOUT_MS - (Date.now() - startedAt);
          if (readyTimeout <= 0) {
            throw createConnectTimeoutError();
          }
          await waitForReady(currentClient, this.connector, readyTimeout);
        }
        return currentClient;
      } catch (error) {
        await this._closeClient(currentClient, {preserveConnectPromise: true});
        const canRetry =
          this.sentinel &&
          !this.closing &&
          !this.closed &&
          retries < REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES &&
          Date.now() - startedAt < REDIS_CONNECT_TIMEOUT_MS;
        if (!canRetry) {
          throw error;
        }
        const retryDelay = Math.min(
          REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS * 2 ** retries,
          REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
          REDIS_CONNECT_TIMEOUT_MS - (Date.now() - startedAt)
        );
        retries++;
        if (retryDelay <= 0) {
          throw createConnectTimeoutError();
        }
        await wait(retryDelay);
      }
    }
  };

  RedisConnection.prototype.isConnected = function () {
    if (this.closed || !this.client) {
      return false;
    }
    return Boolean(this.client.isReady ?? this.client.isOpen);
  };

  RedisConnection.prototype._getClientSnapshot = function (client = this.client, generation = this.clientGeneration) {
    return {client, generation};
  };

  RedisConnection.prototype._getClient = function ({client, generation}) {
    if (!client || client !== this.client || generation !== this.clientGeneration) {
      throw new RedisUnavailableError(new Error('Redis client is unavailable'));
    }
    return client;
  };
};
