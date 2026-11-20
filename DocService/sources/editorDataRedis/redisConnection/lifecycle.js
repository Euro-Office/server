/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {errorDetails, withTimeout, destroyClient, releaseClient, RedisUnavailableError} = require('./helpers');
const {releaseClusterClient} = require('./clusterNodes');
const {log} = require('./helpers');

module.exports = function attachLifecycle(RedisConnection) {
  RedisConnection.prototype.close = async function () {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.closed && !this.client) {
      return;
    }
    this.closing = true;
    // A connect in progress would otherwise run to its deadline first.
    this.connectAbort?.abort();
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
  };

  // Ends the connect in progress. connectPromise stays until that connect has
  // unwound, so a new connect() cannot run a second loop beside it.
  RedisConnection.prototype.cancelConnect = function () {
    if (!this.connectPromise) {
      return false;
    }
    this.connectAbort?.abort();
    this._abortClient(undefined, {preserveConnectPromise: true});
    return true;
  };

  RedisConnection.prototype._detachClient = function (expectedClient = this.client, expectedGeneration, {preserveConnectPromise = false} = {}) {
    if (expectedClient && expectedClient !== this.client) {
      return null;
    }
    if (expectedGeneration !== undefined && expectedGeneration !== this.clientGeneration) {
      return null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      this.clientGeneration++;
    }
    if (!preserveConnectPromise) {
      this.connectPromise = null;
    }
    this.connectionAttempted = false;
    this.lastError = null;
    return client;
  };

  RedisConnection.prototype._closeClient = async function (expectedClient = this.client, {preserveConnectPromise = false} = {}) {
    const client = this._detachClient(expectedClient, undefined, {preserveConnectPromise});
    if (!client || !client.isOpen) {
      return;
    }
    if (this.cluster && client.isReady && client.masters) {
      releaseClusterClient(client);
      return;
    }
    if (client.isReady === false) {
      // A connect or handshake is still in flight. close() would wait for it,
      // forever against a server that accepts connections but does not answer,
      // and once close() has started node-redis no longer lets destroy()
      // release the socket (see releaseClient).
      log('debug', 'releasing redis client that is not ready');
      releaseClient(client, {waitForConnect: !this.sentinel});
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
      destroyClient(client);
    }
  };

  RedisConnection.prototype._withOperation = function (operation) {
    if (this.closing || this.closed) {
      return Promise.reject(new RedisUnavailableError(new Error('Redis connection is closed')));
    }
    this.activeOperations++;
    const previous = this.serializeOperations ? this.operationTail : Promise.resolve();
    // On the serialized lane each operation would otherwise start its own
    // full connect attempt (REDIS_CONNECT_TIMEOUT_MS) one after another during
    // an outage: the Nth queued operation failed only after N attempts. One
    // that was queued when a connect failed fails with that connect instead;
    // operations queued later try a new connect.
    const connectFailuresAtQueue = this.connectFailures;
    const execution = previous.then(() => {
      if (this.serializeOperations && this.connectFailures !== connectFailuresAtQueue && !this.isConnected()) {
        throw new RedisUnavailableError(this.lastConnectError);
      }
      return Promise.resolve().then(operation);
    });
    const result = execution.finally(() => {
      this.activeOperations--;
      if (this.activeOperations === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        waiters.forEach(resolve => resolve());
      }
    });
    if (this.serializeOperations) {
      this.operationTail = result.catch(() => undefined);
    }
    return result;
  };

  RedisConnection.prototype._waitForIdle = function () {
    if (this.activeOperations === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleWaiters.push(resolve));
  };

  RedisConnection.prototype._abortClient = function (clientSnapshot = this._getClientSnapshot(), {preserveConnectPromise = false} = {}) {
    const client = this._detachClient(clientSnapshot.client, clientSnapshot.generation, {preserveConnectPromise});
    if (!client || !client.isOpen) {
      return;
    }
    if (this.cluster && client.isReady && client.masters) {
      releaseClusterClient(client);
      return;
    }
    releaseClient(client, {waitForConnect: !this.sentinel});
  };
};
