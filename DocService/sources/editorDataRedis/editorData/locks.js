/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {ADD_LOCKS_SCRIPT, ADD_LOCKS_NX_SCRIPT, REMOVE_LOCKS_SCRIPT} = require('../scripts');
const {cfgExpLocks} = require('../editorDataSettings');
const {ttlSeconds, argsFromObject, decodeHash} = require('../redisValueCodec');

module.exports = function attachLocks(EditorData) {
  EditorData.prototype.lockSave = async function (ctx, docId, userId, ttl) {
    return this._checkAndLock(ctx, 'savelock', docId, userId, ttl);
  };

  EditorData.prototype.unlockSave = async function (ctx, docId, userId) {
    return this._checkAndUnlock(ctx, 'savelock', docId, userId);
  };

  EditorData.prototype.lockAuth = async function (ctx, docId, userId, ttl) {
    return this._checkAndLock(ctx, 'lockdocument', docId, userId, ttl);
  };

  EditorData.prototype.unlockAuth = async function (ctx, docId, userId) {
    return this._checkAndUnlock(ctx, 'lockdocument', docId, userId);
  };

  EditorData.prototype.addLocks = async function (ctx, docId, locks) {
    const args = argsFromObject(locks);
    if (args.length === 0) {
      return;
    }
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.locks', cfgExpLocks);
    args.push(String(ttl));
    const key = this._docKeys(ctx, docId).locks;
    await this._eval(ADD_LOCKS_SCRIPT, [key], args);
  };

  EditorData.prototype.addLocksNX = async function (ctx, docId, locks) {
    const args = argsFromObject(locks);
    const key = this._docKeys(ctx, docId).locks;
    if (args.length === 0) {
      return {lockConflict: {}, allLocks: await this.getLocks(ctx, docId)};
    }
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.locks', cfgExpLocks);
    args.push(String(ttl));
    const result = await this._eval(ADD_LOCKS_NX_SCRIPT, [key], args);
    return {
      lockConflict: decodeHash(result && result[0]),
      allLocks: decodeHash(result && result[1])
    };
  };

  EditorData.prototype.removeLocks = async function (ctx, docId, locks) {
    const args = argsFromObject(locks);
    if (args.length > 0) {
      await this._eval(REMOVE_LOCKS_SCRIPT, [this._docKeys(ctx, docId).locks], args);
    }
  };

  EditorData.prototype.removeAllLocks = async function (ctx, docId) {
    await this._command(['DEL', this._docKeys(ctx, docId).locks]);
  };

  EditorData.prototype.getLocks = async function (ctx, docId) {
    const result = await this._command(['HGETALL', this._docKeys(ctx, docId).locks]);
    return decodeHash(result);
  };
};
