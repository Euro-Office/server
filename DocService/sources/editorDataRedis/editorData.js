'use strict';

const {
  EditorCommon,
  cfgRedisPrefix,
  cfgExpPresence,
  cfgExpLocks,
  cfgExpMessage,
  cfgExpForceSave,
  cfgExpSaved,
  ttlSeconds,
  jsonEncode,
  jsonDecode,
  decodeHash,
  argsFromObject,
  strictMax,
  toRedisString,
  documentMember,
  decodeDocumentMember,
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  REMOVE_DOCUMENT_INDEX_SCRIPT,
  POP_EXPIRED_SCRIPT,
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT,
  ADD_MESSAGE_SCRIPT,
  GETDEL_SCRIPT,
  START_FORCE_SAVE_SCRIPT,
  SET_FORCE_SAVE_SCRIPT,
  STORE_FORCE_SAVE_SCRIPT,
  CLEAN_DOCUMENT_SCRIPT
} = require('./base');

function EditorData() {
  EditorCommon.call(this);
  this.documentsKey = `${cfgRedisPrefix}{editor:index}:documents`;
  this.forceSaveTimerKey = `${cfgRedisPrefix}{editor:index}:forcesavetimer`;
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

EditorData.prototype.getPresence = async function (ctx, docId) {
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

EditorData.prototype.getDocumentPresenceExpired = async function (now) {
  const values = await this._eval(POP_EXPIRED_SCRIPT, [this.documentsKey], [strictMax(now)]);
  const result = [];
  for (const value of values || []) {
    const item = decodeDocumentMember(value);
    if (item) {
      result.push(item);
    }
  }
  return result;
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

EditorData.prototype.setForceSave = async function (ctx, docId, time, index, baseUrl, changeInfo, convertInfo) {
  const value = {time, index, baseUrl, changeInfo, started: false, ended: false, convertInfo};
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
  const key = this._docKeys(ctx, docId).forceSave;
  await this._eval(STORE_FORCE_SAVE_SCRIPT, [key], [jsonEncode(value), String(ttl)]);
};

EditorData.prototype.getForceSave = async function (ctx, docId) {
  const result = await this._command(['HGET', this._docKeys(ctx, docId).forceSave, 'state']);
  return jsonDecode(result, null);
};

EditorData.prototype.checkAndStartForceSave = async function (ctx, docId) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
  const result = await this._eval(START_FORCE_SAVE_SCRIPT, [this._docKeys(ctx, docId).forceSave], [String(ttl)]);
  return jsonDecode(result, undefined);
};

EditorData.prototype.checkAndSetForceSave = async function (ctx, docId, time, index, started, ended, convertInfo) {
  const hasConvertInfo = convertInfo !== undefined;
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
  const result = await this._eval(
    SET_FORCE_SAVE_SCRIPT,
    [this._docKeys(ctx, docId).forceSave],
    [jsonEncode(time), jsonEncode(index), started ? '1' : '0', ended ? '1' : '0', hasConvertInfo ? '1' : '0', jsonEncode(convertInfo), String(ttl)]
  );
  return jsonDecode(result, undefined);
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

EditorData.prototype.getForceSaveTimer = async function (now) {
  const values = await this._eval(POP_EXPIRED_SCRIPT, [this.forceSaveTimerKey], [strictMax(now)]);
  const result = [];
  for (const value of values || []) {
    const item = decodeDocumentMember(value);
    if (item) {
      result.push(item);
    }
  }
  return result;
};

module.exports = EditorData;
