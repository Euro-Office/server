/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {MultiErrorReply} = require('@redis/client/dist/lib/errors');
const calculateSlot = require('cluster-key-slot');
const {toRedisString} = require('../redisValueCodec');
const {hasNodeCluster} = require('../redisConfig');
const {log, errorDetails, withTimeout, RedisUnavailableError} = require('./helpers');

// The server this client talks to is no longer a writable primary.
function isPrimaryLostError(error) {
  if (error instanceof MultiErrorReply) {
    return [...error.errors()].some(isPrimaryLostError);
  }
  return /^(READONLY|MASTERDOWN)(?:\s|$)/.test(error?.message || '');
}

module.exports = function attachCommands(RedisConnection) {
  RedisConnection.prototype.command = async function (args) {
    return this._withOperation(() => this._command(args));
  };

  RedisConnection.prototype.commands = async function (commands) {
    // this.cluster is set when a client is created; before the first one the
    // configuration decides (a MULTI on a cluster client fails).
    if (this.client ? this.cluster : hasNodeCluster()) {
      // Cluster batches are independent commands. Route them through the
      // operation boundary individually so a timed-out command cannot abort
      // another batch member that has not reached the wire yet.
      return Promise.all(commands.map(command => this.command(command)));
    }
    return this._withOperation(() => this._commands(commands));
  };

  RedisConnection.prototype._command = async function (args) {
    const clientSnapshot = await this._connect();
    const client = this._getClient(clientSnapshot);
    const normalized = args.map(toRedisString);
    const commandName = normalized[0] ? normalized[0].toUpperCase() : 'UNKNOWN';
    const startedAt = Date.now();
    log('debug', 'command start %s (keys=%d)', commandName, Math.max(0, normalized.length - 1));
    try {
      let result;
      if (this.cluster) {
        const command = normalized[0].toUpperCase();
        const firstKey = command === 'EVAL' ? normalized[3] : command === 'PING' ? undefined : normalized[1];
        if (firstKey === undefined && typeof client.getMasters === 'function') {
          // A keyless command (PING) goes to a master that is reachable, not to
          // a random node that may not be.
          result = (await this._readyClusterMaster(client)).sendCommand(normalized);
        } else {
          this._requireClusterSlot(client, firstKey);
          result = client.sendCommand(firstKey, false, normalized);
        }
      } else if (this.sentinel) {
        result = client.sendCommand(false, normalized);
      } else {
        result = client.sendCommand(normalized);
      }
      result = await this._withCommandTimeout(result, `Redis command ${commandName}`, clientSnapshot);
      log('debug', 'command end %s after %dms', commandName, Date.now() - startedAt);
      return result;
    } catch (error) {
      log('error', 'command failed %s after %dms (connector=%s): %s', commandName, Date.now() - startedAt, this.connector, errorDetails(error));
      throw error;
    }
  };

  // node-redis fails with a TypeError, and never reads the topology again,
  // when its slot map has no owner for the key (a cluster whose slots are not
  // assigned yet, or a failed discovery).
  RedisConnection.prototype._requireClusterSlot = function (client, key) {
    if (!Array.isArray(client.slots) || client.slots[calculateSlot(key)]?.master) {
      return;
    }
    this._refreshClusterTopology(client);
    throw new RedisUnavailableError(new Error('Redis Cluster has no owner for the slot of this key'));
  };

  // The client of a master that is ready (node waits are limited, see
  // clusterNodes.js).
  RedisConnection.prototype._readyClusterMaster = async function (client) {
    const masters = [...client.getMasters()].sort(() => Math.random() - 0.5);
    let lastError = new Error('Redis Cluster has no masters');
    for (const node of masters) {
      if (client !== this.client || !client.isOpen) {
        // Released meanwhile: do not create node clients for it.
        throw new RedisUnavailableError(new Error('Redis client is unavailable'));
      }
      try {
        return await client.nodeClient(node);
      } catch (error) {
        lastError = error;
      }
    }
    if (masters.length === 0) {
      this._refreshClusterTopology(client);
    }
    throw lastError instanceof RedisUnavailableError ? lastError : new RedisUnavailableError(lastError);
  };

  RedisConnection.prototype._commands = async function (commands) {
    const clientSnapshot = await this._connect();
    const client = this._getClient(clientSnapshot);
    const multi = client.multi();
    for (const args of commands) {
      const normalized = args.map(toRedisString);
      multi.addCommand(...(this.sentinel ? [false, normalized] : [normalized]));
    }
    return this._withCommandTimeout(multi.exec(), `Redis transaction with ${commands.length} commands`, clientSnapshot);
  };

  RedisConnection.prototype.eval = async function (script, keys, args) {
    return this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
  };

  RedisConnection.prototype._withCommandTimeout = async function (promise, description, clientSnapshot = this._getClientSnapshot()) {
    try {
      return await withTimeout(promise, this.commandTimeoutMs, description);
    } catch (error) {
      const timedOut = error.code === 'ETIMEDOUT' || error.constructor?.name === 'TimeoutError';
      // READONLY/MASTERDOWN means the primary moved. Sentinel rediscovers it;
      // a standalone endpoint (a DNS name or Service that follows a managed
      // failover) must reconnect too, because a demoted primary may keep the
      // old socket open and would answer every write with READONLY.  Cluster
      // clients follow MOVED redirects themselves.
      if (timedOut || (!this.cluster && isPrimaryLostError(error))) {
        // Reconnect on the next operation, without replaying this command or
        // transaction: it may already have applied some of its writes.
        this._abortClient(clientSnapshot);
      }
      throw error;
    }
  };
};
