/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const redis = require('redis');
const {
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_MIN_ATTEMPT_MS,
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
  createConnectCancelledError,
  untilAborted,
  wait,
  probeSentinel,
  probeClusterRootNode,
  trackConnect,
  RedisUnavailableError
} = require('./helpers');
const {limitClusterNodeWaits} = require('./clusterNodes');

// How long each Sentinel or Cluster root node gets to answer the check before
// a new client is created (all of them are checked at the same time).
const REDIS_SENTINEL_PROBE_TIMEOUT_MS = 2000;

const sentinelNodeKey = node => `${node.host}:${node.port}`;

// node-redis asks the Sentinels one after another and has no timeout for a
// Sentinel that accepts the connection but never answers. Such a Sentinel would
// use up the whole connect budget in one attempt. So an attempt through
// Sentinel gets a share of the budget, and the next attempt starts at the next
// Sentinel (see normalizeSentinelOptions).
function sentinelAttemptTimeoutMs(rootNodeCount) {
  const count = Number.isInteger(rootNodeCount) && rootNodeCount > 0 ? rootNodeCount : 1;
  return Math.max(REDIS_SENTINEL_MIN_ATTEMPT_MS, Math.floor(REDIS_CONNECT_TIMEOUT_MS / count));
}

// node-redis connects a Cluster client to every master before connect()
// resolves. While a master is frozen and its replica is not promoted yet, one
// attempt waits for it to the end of the connect budget, although a new
// attempt would connect as soon as the failover is done (the frozen node is no
// longer listed). So an attempt gets a third of the budget and is retried.
const CLUSTER_ATTEMPT_TIMEOUT_MS = Math.max(REDIS_SENTINEL_MIN_ATTEMPT_MS, Math.floor(REDIS_CONNECT_TIMEOUT_MS / 3));

// node-redis reports a node by the address it connects to, which differs from
// the node's cluster address when optionsCluster.nodeAddressMap maps it.
function clusterNodeAddress(client, socket) {
  for (const [address, node] of client.nodeByAddress || []) {
    const options = node.client?.options?.socket;
    if (options && options.host === socket?.host && options.port === socket?.port) {
      return address;
    }
  }
  return undefined;
}

module.exports = function attachConnect(RedisConnection) {
  // reachableSentinelRootNodes: the "host:port" keys of the Sentinels that
  // answered the check (see _probeSentinelRootNodes). reachableClusterRootNodes:
  // the indexes of the Cluster root nodes that answered (_probeClusterRootNodes).
  // lazyCluster: connect a Cluster client without connecting every master
  // first (see _connectWithRetries).
  RedisConnection.prototype._createClient = function ({reachableSentinelRootNodes, reachableClusterRootNodes, lazyCluster = false} = {}) {
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
      // Each new Sentinel client starts at the next root node.
      const sentinelOptions = normalizeSentinelOptions(cfgRedisOptionsSentinel, this.database, this.sentinelRootNodeOffset++);
      // Leave out the Sentinels that did not answer the check, unless none did:
      // then node-redis reports the failure as usual.
      const reachable = sentinelOptions.sentinelRootNodes.filter(node => reachableSentinelRootNodes?.has(sentinelNodeKey(node)));
      if (reachable.length > 0) {
        sentinelOptions.sentinelRootNodes = reachable;
      }
      this.sentinelRootNodeCount = sentinelOptions.sentinelRootNodes.length;
      client = createSentinelClient(sentinelOptions);
    } else if (this.cluster) {
      if (this.database !== undefined && this.database !== null && Number(this.database) !== 0) {
        log('error', 'Redis Cluster cannot use logical database %s; configure database 0', this.database);
        throw new Error('Redis Cluster does not support a non-zero logical database');
      }
      const clusterOptions = normalizeClusterOptions(cfgRedisOptionsCluster);
      // Leave out the root nodes that did not answer the check, unless none
      // did: node-redis discovers through one root node, never moves on to the
      // next, and has no timeout for one that accepts the connection but does
      // not answer (a frozen node).
      const reachable = (clusterOptions.rootNodes || []).filter((_node, index) => reachableClusterRootNodes?.has(index));
      if (reachable.length > 0) {
        clusterOptions.rootNodes = reachable;
      }
      if (lazyCluster) {
        clusterOptions.minimizeConnections ??= true;
      }
      client = redis.createCluster(clusterOptions);
      const clusterClient = client;
      client.on('node-reconnecting', node => this._refreshClusterTopology(clusterClient, clusterNodeAddress(clusterClient, node)));
      limitClusterNodeWaits(client, address => this._refreshClusterTopology(clusterClient, address));
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

  // Checks every configured Sentinel at the same time. Resolves the keys of the
  // ones that answered, or undefined when the Sentinel options are invalid
  // (_createClient then reports that).
  RedisConnection.prototype._probeSentinelRootNodes = async function (timeoutMs) {
    let options;
    try {
      options = normalizeSentinelOptions(cfgRedisOptionsSentinel, this.database);
    } catch (_error) {
      return undefined;
    }
    const answered = await Promise.all(options.sentinelRootNodes.map(node => probeSentinel(node, options.sentinelClientOptions, timeoutMs)));
    return new Set(options.sentinelRootNodes.filter((_node, index) => answered[index]).map(sentinelNodeKey));
  };

  // A node client reconnects after its socket failed (a frozen master is
  // noticed by the idle-socket timeout, see clusterOptions.js). node-redis
  // reads the topology again only on a reconnect attempt that comes at least
  // its delay after the first one, and each attempt against a frozen node
  // waits for that timeout: the slots of a promoted replica stayed unreachable
  // for another timeout. Read it at once, without the reconnecting node.
  RedisConnection.prototype._refreshClusterTopology = function (client, address) {
    const now = Date.now();
    if (client !== this.client || !client.isOpen || now - (this.lastClusterTopologyRefreshAt || 0) < 1000) {
      return;
    }
    this.lastClusterTopologyRefreshAt = now;
    Promise.resolve()
      .then(() => client._slots?.rediscover?.(undefined, address ? new Set([address]) : undefined))
      .catch(error => log('warn', 'Redis Cluster topology refresh failed: %s', errorDetails(error)));
  };

  // Checks every configured Cluster root node at the same time. Resolves the
  // indexes of the ones that answered, or undefined when the Cluster options
  // are invalid (_createClient then reports that).
  RedisConnection.prototype._probeClusterRootNodes = async function (timeoutMs) {
    let options;
    try {
      options = normalizeClusterOptions(cfgRedisOptionsCluster);
    } catch (_error) {
      return undefined;
    }
    const rootNodes = Array.isArray(options.rootNodes) ? options.rootNodes : [];
    const answered = await Promise.all(rootNodes.map(node => probeClusterRootNode(node, options.defaults, timeoutMs)));
    return new Set(answered.flatMap((ok, index) => (ok ? [index] : [])));
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
    // A Sentinel or Cluster client is created by _connectWithRetries, after
    // the Sentinels or Cluster root nodes were checked.
    if (!this.client && !hasNodeSentinel() && !hasNodeCluster()) {
      this._createClient();
    }
    const currentClient = this.client;
    if (currentClient && this.connectionAttempted && currentClient.isOpen && !currentClient.isReady) {
      throw new RedisUnavailableError(this.lastError);
    }
    const startedAt = Date.now();
    log(
      'debug',
      'connect start (connector=%s, status=%s, open=%s, ready=%s)',
      this.connector,
      currentClient?.status || 'n/a',
      currentClient?.isOpen ?? 'n/a',
      currentClient?.isReady ?? 'n/a'
    );
    this.connectionAttempted = true;
    // cancelConnect() and close() abort this connect loop (see untilAborted).
    const connectAbort = new AbortController();
    this.connectAbort = connectAbort;
    const connectPromise = this._connectWithRetries(startedAt, connectAbort.signal);
    this.connectPromise = connectPromise;
    try {
      const connectedClient = await connectPromise;
      log('debug', 'connect ready after %dms (connector=%s)', Date.now() - startedAt, this.connector);
      return this._getClientSnapshot(connectedClient);
    } catch (error) {
      this.connectFailures++;
      this.lastConnectError = error;
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
      await this._closeClient(currentClient ?? undefined);
      throw error;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
      if (this.connectAbort === connectAbort) {
        this.connectAbort = null;
      }
    }
  };

  RedisConnection.prototype._connectWithRetries = async function (startedAt, signal) {
    let retries = 0;
    // node-redis connects a Cluster client to every master before connect()
    // resolves. A master that this process cannot reach while the cluster keeps
    // it (a partition that is never failed over) would fail every connect, also
    // for the slots of the other masters. When an attempt failed although a
    // root node answered, the next one connects without the masters; a node is
    // then connected on its first command (see clusterNodes.js).
    let lazyCluster = false;
    let clusterRootAnswered = false;
    while (true) {
      if (this.closing || this.closed) {
        throw new RedisUnavailableError(new Error('Redis connection is closing'));
      }
      if (signal?.aborted) {
        throw createConnectCancelledError();
      }
      if (!this.client) {
        let reachableSentinelRootNodes;
        let reachableClusterRootNodes;
        const sentinel = hasNodeSentinel();
        const cluster = !sentinel && hasNodeCluster();
        if (sentinel || cluster) {
          const remainingForProbe = REDIS_CONNECT_TIMEOUT_MS - (Date.now() - startedAt);
          if (remainingForProbe <= 0) {
            throw createConnectTimeoutError();
          }
          const probeTimeout = Math.min(REDIS_SENTINEL_PROBE_TIMEOUT_MS, remainingForProbe);
          if (sentinel) {
            reachableSentinelRootNodes = await untilAborted(this._probeSentinelRootNodes(probeTimeout), signal);
          } else {
            reachableClusterRootNodes = await untilAborted(this._probeClusterRootNodes(probeTimeout), signal);
            clusterRootAnswered = reachableClusterRootNodes?.size > 0;
          }
        }
        this._createClient({reachableSentinelRootNodes, reachableClusterRootNodes, lazyCluster});
      }
      const currentClient = this.client;
      this.connectionAttempted = true;
      const remaining = REDIS_CONNECT_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        throw createConnectTimeoutError();
      }
      const attemptTimeout = this.sentinel
        ? sentinelAttemptTimeoutMs(this.sentinelRootNodeCount)
        : this.cluster
          ? CLUSTER_ATTEMPT_TIMEOUT_MS
          : remaining;
      const attemptDeadline = Date.now() + Math.min(remaining, attemptTimeout);
      try {
        if (!currentClient.isOpen) {
          await untilAborted(
            withTimeout(trackConnect(currentClient, currentClient.connect()), attemptDeadline - Date.now(), 'Redis connect'),
            signal
          );
        }
        if (!currentClient.isReady) {
          const readyTimeout = attemptDeadline - Date.now();
          if (readyTimeout <= 0) {
            throw createConnectTimeoutError();
          }
          await untilAborted(waitForReady(currentClient, this.connector, readyTimeout), signal);
        }
        return currentClient;
      } catch (error) {
        await this._closeClient(currentClient, {preserveConnectPromise: true});
        if (this.cluster && clusterRootAnswered) {
          lazyCluster = true;
        }
        const canRetry =
          (this.sentinel || this.cluster) &&
          !signal?.aborted &&
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
        await untilAborted(wait(retryDelay), signal);
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
