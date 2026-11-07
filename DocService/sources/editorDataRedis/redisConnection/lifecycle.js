/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {errorDetails, withTimeout, RedisUnavailableError} = require('./helpers');
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

  RedisConnection.prototype.cancelConnect = function () {
    if (!this.connectPromise) {
      return false;
    }
    this._abortClient();
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
  };

  RedisConnection.prototype._withOperation = function (operation) {
    if (this.closing || this.closed) {
      return Promise.reject(new RedisUnavailableError(new Error('Redis connection is closed')));
    }
    this.activeOperations++;
    const previous = this.serializeOperations ? this.operationTail : Promise.resolve();
    const execution = previous.then(() => Promise.resolve().then(operation));
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

  RedisConnection.prototype._abortClient = function (clientSnapshot = this._getClientSnapshot()) {
    const client = this._detachClient(clientSnapshot.client, clientSnapshot.generation);
    if (!client || !client.isOpen) {
      return;
    }
    if (typeof client.destroy === 'function') {
      client.destroy();
    } else if (typeof client.disconnect === 'function') {
      client.disconnect();
    }
  };
};
