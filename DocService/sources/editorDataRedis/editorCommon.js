/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const commonDefines = require('./../../../Common/sources/commondefines');
const {redisConnectionManager} = require('./redisConnectionManager');
const {RedisUnavailableError} = require('./redisConnection');
const {LOCK_SCRIPT, UNLOCK_SCRIPT} = require('./scripts');
const {cfgRedisPrefix, encodePart, tenantName} = require('./redisKeys');
const {jsonEncode, ttlMilliseconds} = require('./redisValueCodec');

function EditorCommon(database) {
  this.database = database;
  // EditorCommon instances lease a shared connection. The manager keeps the
  // physical client alive until every component using that database releases it.
  this.redis = redisConnectionManager.acquire(database);
  this.closed = false;
}

EditorCommon.prototype._ensureRedisLease = function () {
  if (this.closed) {
    throw new RedisUnavailableError(new Error('Editor data store is closed'));
  }
  if (!redisConnectionManager.owns(this.redis)) {
    this.redis = redisConnectionManager.acquire(this.database);
  }
  return this.redis;
};

EditorCommon.prototype.connect = async function () {
  return this._ensureRedisLease().connect();
};

EditorCommon.prototype.isConnected = function () {
  return !this.closed && redisConnectionManager.owns(this.redis) && this.redis.isConnected();
};

EditorCommon.prototype.ping = async function () {
  return this._ensureRedisLease().command(['PING']);
};

EditorCommon.prototype.close = async function () {
  if (this.closed) {
    return;
  }
  this.closed = true;
  return redisConnectionManager.release(this.redis);
};

EditorCommon.prototype.healthCheck = async function () {
  try {
    return (await this.ping()) === 'PONG';
  } catch (_e) {
    return false;
  }
};

EditorCommon.prototype._eval = function (script, keys, args) {
  return this._ensureRedisLease().eval(script, keys, args);
};

EditorCommon.prototype._command = function (args) {
  return this._ensureRedisLease().command(args);
};

EditorCommon.prototype._commands = function (commands) {
  return this._ensureRedisLease().commands(commands);
};

EditorCommon.prototype._docBase = function (ctx, docId) {
  return `${cfgRedisPrefix}{editor:${encodePart(tenantName(ctx))}:${encodePart(docId)}}:`;
};

EditorCommon.prototype._statBase = function (ctx) {
  return `${cfgRedisPrefix}{stat:${encodePart(tenantName(ctx))}}:`;
};

EditorCommon.prototype._checkAndLock = async function (ctx, name, docId, fencingToken, ttl) {
  const key = `${this._docBase(ctx, docId)}${name}`;
  try {
    const result = await this._eval(LOCK_SCRIPT, [key], [jsonEncode(fencingToken), String(ttlMilliseconds(ttl))]);
    return Number(result) === 1;
  } catch (_error) {
    // Redis availability must never make a caller believe that it acquired a
    // lock. Denying the lock is safe; treating the failure as an acquisition
    // could allow concurrent writers to proceed.
    return false;
  }
};

EditorCommon.prototype._checkAndUnlock = async function (ctx, name, docId, fencingToken) {
  const key = `${this._docBase(ctx, docId)}${name}`;
  const unlock = commonDefines.c_oAscUnlockRes;
  try {
    const result = await this._eval(
      UNLOCK_SCRIPT,
      [key],
      [jsonEncode(fencingToken), String(unlock.Unlocked), String(unlock.Empty), String(unlock.Locked)]
    );
    return Number(result);
  } catch (_error) {
    // The caller must not continue down the "unlocked" branch when the result
    // is unknown. Locked is the fail-closed enum value used by callers.
    return unlock.Locked;
  }
};

module.exports = {EditorCommon};
