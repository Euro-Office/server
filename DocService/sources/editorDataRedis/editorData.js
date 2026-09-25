/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {randomUUID} = require('crypto');

const {EditorCommon} = require('./editorCommon');
const {cfgRedisPrefix, documentMember, decodeDocumentMember} = require('./redisKeys');
const {ttlSeconds, jsonEncode, jsonDecode, decodeHash, argsFromObject, strictMax, toRedisString} = require('./redisValueCodec');
const {
  cfgExpPresence,
  cfgExpLocks,
  cfgExpMessage,
  cfgExpForceSave,
  cfgExpSaved,
  POP_EXPIRED_BATCH_SIZE,
  POP_EXPIRED_LEASE_MS
} = require('./editorDataSettings');
const {
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  REMOVE_DOCUMENT_INDEX_SCRIPT,
  POP_EXPIRED_SCRIPT,
  ACK_EXPIRED_SCRIPT,
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT,
  ADD_MESSAGE_SCRIPT,
  GETDEL_SCRIPT,
  FORCE_SAVE_FIELDS,
  START_FORCE_SAVE_SCRIPT,
  SET_FORCE_SAVE_SCRIPT,
  STORE_FORCE_SAVE_SCRIPT,
  CLEAN_DOCUMENT_SCRIPT
} = require('./scripts');

const expiredClaimIds = new WeakMap();

function EditorData() {
  EditorCommon.call(this);
  this.documentsKey = `${cfgRedisPrefix}{editor:index}:documents`;
  this.forceSaveTimerKey = `${cfgRedisPrefix}{editor:index}:forcesavetimer`;
  this.documentsExpiredLeaseKey = `${cfgRedisPrefix}{editor:index}:documents:expired:lease`;
  this.documentsExpiredClaimsKey = `${cfgRedisPrefix}{editor:index}:documents:expired:claims`;
  this.forceSaveExpiredLeaseKey = `${cfgRedisPrefix}{editor:index}:forcesavetimer:expired:lease`;
  this.forceSaveExpiredClaimsKey = `${cfgRedisPrefix}{editor:index}:forcesavetimer:expired:claims`;
  this.expiredClaimOwner = randomUUID();
  this.expiredClaimSequence = 0;
  // Tests can shorten this internal lease; production keeps enough time for a
  // normal GC pass while still recovering a lost response on a later pass.
  this.expiredClaimLeaseMs = POP_EXPIRED_LEASE_MS;
}

EditorData.prototype = Object.create(EditorCommon.prototype);
EditorData.prototype.constructor = EditorData;

EditorData.prototype._docKeys = function (ctx, docId) {
  const base = this._docBase(ctx, docId);
  return {
    presenceSet: `${base}presence:set`,
    presenceHash: `${base}presence:hash`,
    presenceVersion: `${base}presence:version`,
    saveLock: `${base}savelock`,
    authLock: `${base}lockdocument`,
    locks: `${base}locks`,
    messages: `${base}message`,
    saved: `${base}saved`,
    forceSave: `${base}forcesave`
  };
};

EditorData.prototype.addPresence = async function (ctx, docId, userId, userInfo) {
  const keys = this._docKeys(ctx, docId);
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
  const expireAt = Date.now() + ttl * 1000;
  await this._eval(
    ADD_PRESENCE_SCRIPT,
    [keys.presenceSet, keys.presenceHash, keys.presenceVersion],
    [String(userId), String(userInfo), String(expireAt), String(ttl)]
  );
  // The document index is intentionally updated separately: document presence
  // keys are hash-tagged per document, while this global index has its own
  // hash tag. Redis Cluster cannot execute both key groups in one Lua script.
  // The expiry score and cleanup paths tolerate a briefly stale index entry.
  await this._command(['ZADD', this.documentsKey, String(expireAt), documentMember(ctx, docId)]);
};

EditorData.prototype.updatePresence = async function (ctx, docId, userId) {
  const keys = this._docKeys(ctx, docId);
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
  const expireAt = Date.now() + ttl * 1000;
  const updated = await this._eval(
    UPDATE_PRESENCE_SCRIPT,
    [keys.presenceSet, keys.presenceHash, keys.presenceVersion],
    [String(userId), String(expireAt), String(ttl)]
  );
  if (Number(updated) === 1) {
    await this._command(['ZADD', this.documentsKey, String(expireAt), documentMember(ctx, docId)]);
  }
};

EditorData.prototype.removePresence = async function (ctx, docId, userId) {
  const keys = this._docKeys(ctx, docId);
  await this._eval(REMOVE_PRESENCE_SCRIPT, [keys.presenceSet, keys.presenceHash], [String(userId)]);
};

EditorData.prototype.getPresence = async function (ctx, docId, _connections) {
  const keys = this._docKeys(ctx, docId);
  const result = await this._eval(GET_PRESENCE_SCRIPT, [keys.presenceSet, keys.presenceHash], [String(Date.now())]);
  return (result || []).map(toRedisString);
};

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

EditorData.prototype._nextExpiredClaim = function () {
  this.expiredClaimSequence += 1;
  return `${this.expiredClaimOwner}:${this.expiredClaimSequence}`;
};

EditorData.prototype._popExpired = async function (indexKey, leaseKey, claimsKey, now) {
  const claimId = this._nextExpiredClaim();
  const values = await this._eval(
    POP_EXPIRED_SCRIPT,
    [indexKey, leaseKey, claimsKey],
    [strictMax(now), String(Date.now() + this.expiredClaimLeaseMs), String(POP_EXPIRED_BATCH_SIZE), claimId]
  );
  const result = [];
  for (const value of values || []) {
    const item = decodeDocumentMember(value);
    if (item) {
      expiredClaimIds.set(item, claimId);
      result.push(item);
    }
  }
  return result;
};

EditorData.prototype._ackExpired = async function (leaseKey, claimsKey, item) {
  const claimId = item && expiredClaimIds.get(item);
  if (!claimId) {
    return false;
  }
  const member = documentMember({tenant: item[0]}, item[1]);
  const result = await this._eval(ACK_EXPIRED_SCRIPT, [leaseKey, claimsKey], [claimId, member]);
  return Number(result) === 1;
};

EditorData.prototype._ackDocumentPresenceExpired = function (item) {
  return this._ackExpired(this.documentsExpiredLeaseKey, this.documentsExpiredClaimsKey, item);
};

EditorData.prototype.getDocumentPresenceExpired = function (now) {
  return this._popExpired(this.documentsKey, this.documentsExpiredLeaseKey, this.documentsExpiredClaimsKey, now);
};

EditorData.prototype.removePresenceDocument = async function (ctx, docId) {
  const keys = this._docKeys(ctx, docId);
  const result = await this._eval(PREPARE_PRESENCE_REMOVAL_SCRIPT, [keys.presenceSet, keys.presenceHash, keys.presenceVersion], []);
  if (result && Number(result[0]) === 1) {
    await this._eval(
      REMOVE_DOCUMENT_INDEX_SCRIPT,
      [this.documentsKey],
      [documentMember(ctx, docId), toRedisString(result[1] || ''), String(Date.now())]
    );
  }
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

EditorData.prototype.addMessage = async function (ctx, docId, msg) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.message', cfgExpMessage);
  await this._eval(ADD_MESSAGE_SCRIPT, [this._docKeys(ctx, docId).messages], [jsonEncode(msg), String(ttl)]);
};

EditorData.prototype.removeMessages = async function (ctx, docId) {
  await this._command(['DEL', this._docKeys(ctx, docId).messages]);
};

EditorData.prototype.getMessages = async function (ctx, docId) {
  const result = await this._command(['LRANGE', this._docKeys(ctx, docId).messages, '0', '-1']);
  return (result || []).map(value => jsonDecode(value, null));
};

EditorData.prototype.setSaved = async function (ctx, docId, status) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.saved', cfgExpSaved);
  await this._command(['SET', this._docKeys(ctx, docId).saved, String(status), 'EX', String(ttl)]);
};

EditorData.prototype.getdelSaved = async function (ctx, docId) {
  return this._eval(GETDEL_SCRIPT, [this._docKeys(ctx, docId).saved], []);
};

function decodeForceSavePayload(raw, defined) {
  return toRedisString(defined) === '1' ? jsonDecode(raw, null) : undefined;
}

function decodeForceSave(result, fallback) {
  if (!result || result[0] === null || result[0] === undefined) {
    return fallback;
  }
  return {
    time: jsonDecode(result[0], undefined),
    index: jsonDecode(result[1], undefined),
    baseUrl: decodeForceSavePayload(result[2], result[3]),
    changeInfo: decodeForceSavePayload(result[4], result[5]),
    convertInfo: decodeForceSavePayload(result[6], result[7]),
    started: toRedisString(result[8]) === '1',
    ended: toRedisString(result[9]) === '1'
  };
}

EditorData.prototype.setForceSave = async function (ctx, docId, time, index, baseUrl, changeInfo, convertInfo) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
  const key = this._docKeys(ctx, docId).forceSave;
  await this._eval(
    STORE_FORCE_SAVE_SCRIPT,
    [key],
    [
      jsonEncode(time),
      jsonEncode(index),
      jsonEncode(baseUrl),
      baseUrl === undefined ? '0' : '1',
      changeInfo === undefined ? '' : jsonEncode(changeInfo),
      changeInfo === undefined ? '0' : '1',
      convertInfo === undefined ? '' : jsonEncode(convertInfo),
      convertInfo === undefined ? '0' : '1',
      String(ttl)
    ]
  );
};

EditorData.prototype.getForceSave = async function (ctx, docId) {
  const result = await this._command(['HMGET', this._docKeys(ctx, docId).forceSave, ...FORCE_SAVE_FIELDS]);
  return decodeForceSave(result, null);
};

EditorData.prototype.checkAndStartForceSave = async function (ctx, docId) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
  const result = await this._eval(START_FORCE_SAVE_SCRIPT, [this._docKeys(ctx, docId).forceSave], [String(ttl)]);
  return decodeForceSave(result, undefined);
};

EditorData.prototype.checkAndSetForceSave = async function (ctx, docId, time, index, started, ended, convertInfo) {
  const hasConvertInfo = convertInfo !== undefined;
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
  const result = await this._eval(
    SET_FORCE_SAVE_SCRIPT,
    [this._docKeys(ctx, docId).forceSave],
    [
      jsonEncode(time),
      jsonEncode(index),
      started ? '1' : '0',
      ended ? '1' : '0',
      hasConvertInfo ? '1' : '0',
      hasConvertInfo ? jsonEncode(convertInfo) : '',
      String(ttl)
    ]
  );
  return decodeForceSave(result, undefined);
};

EditorData.prototype.removeForceSave = async function (ctx, docId) {
  await this._command(['DEL', this._docKeys(ctx, docId).forceSave]);
};

EditorData.prototype.cleanDocumentOnExit = async function (ctx, docId) {
  const keys = this._docKeys(ctx, docId);
  const result = await this._eval(
    CLEAN_DOCUMENT_SCRIPT,
    [keys.presenceSet, keys.presenceHash, keys.presenceVersion, keys.saveLock, keys.authLock, keys.locks, keys.messages, keys.saved, keys.forceSave],
    [String(Date.now())]
  );
  if (result && Number(result[0]) === 1) {
    const member = documentMember(ctx, docId);
    await this._eval(REMOVE_DOCUMENT_INDEX_SCRIPT, [this.documentsKey], [member, toRedisString(result[1] || ''), String(Date.now())]);
    await this._command(['ZREM', this.forceSaveTimerKey, member]);
  }
};

EditorData.prototype.addForceSaveTimerNX = async function (ctx, docId, expireAt) {
  await this._command(['ZADD', this.forceSaveTimerKey, 'NX', String(expireAt), documentMember(ctx, docId)]);
};

EditorData.prototype._ackForceSaveTimer = function (item) {
  return this._ackExpired(this.forceSaveExpiredLeaseKey, this.forceSaveExpiredClaimsKey, item);
};

EditorData.prototype.getForceSaveTimer = function (now) {
  return this._popExpired(this.forceSaveTimerKey, this.forceSaveExpiredLeaseKey, this.forceSaveExpiredClaimsKey, now);
};

module.exports = EditorData;
