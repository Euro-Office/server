/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {toRedisString} = require('../redisValueCodec');
const {log, errorDetails, withTimeout} = require('./helpers');

module.exports = function attachCommands(RedisConnection) {
  RedisConnection.prototype.command = async function (args) {
    return this._withOperation(() => this._command(args));
  };

  RedisConnection.prototype.commands = async function (commands) {
    if (this.cluster) {
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
        result = client.sendCommand(firstKey, false, normalized);
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
      if (error.code === 'ETIMEDOUT' || error.constructor?.name === 'TimeoutError') {
        this._abortClient(clientSnapshot);
      }
      throw error;
    }
  };
};
