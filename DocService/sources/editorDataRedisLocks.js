'use strict';
const config = require('config');
const Redis = require('ioredis');
const editorDataMemory = require('./editorDataMemory');
const { createSaveLockStore } = require('./editorDataRedisSaveLock');
const { createPresenceStore } = require('./editorDataRedisPresence');

// Save/auth locks and presence backed by Redis. This module is the
// composition root: it owns the Redis connection and the memory-backend
// delegate, and wires each store (editorDataRedisSaveLock.js,
// editorDataRedisPresence.js) against them. Everything not yet ported
// (block locks, messages, save-state, force-save, telemetry) still
// delegates straight to editorDataMemory, unchanged.

function EditorData() {
  this._memory = new editorDataMemory.EditorData();

  const redisCfg = config.get('services.CoAuthoring.redis');
  const prefix = redisCfg.prefix || 'ds:';

  this._redis = new Redis({
    host: redisCfg.host,
    port: redisCfg.port,
    // Failing closed only works if a Redis call fails *promptly* - a
    // stalled connection (mid-Sentinel-failover, a network blip) would
    // otherwise hang a Lua call indefinitely, blocking save/auth for every
    // user on that document. Explicit default (overridable via
    // `iooptions.commandTimeout`), not left at the ioredis default of no
    // timeout at all.
    commandTimeout: 300,
    // `options` is the legacy node-redis config block (services.CoAuthoring
    // still supports both backends); ioredis's own overrides live under
    // `iooptions` - spreading `options` here does nothing real, currently
    // harmless only because it's empty.
    ...(redisCfg.iooptions || {}),
  });

  this._saveLock = createSaveLockStore(this._redis, prefix);
  this._presence = createPresenceStore(
    this._redis,
    prefix,
    config.get('services.CoAuthoring.expire.presence'),
    this._memory
  );
}

EditorData.prototype.connect = async function () {
  await this._memory.connect();
};
EditorData.prototype.isConnected = function () {
  return this._redis.status === 'ready' && this._memory.isConnected();
};
EditorData.prototype.ping = async function () {
  return this._redis.ping();
};
EditorData.prototype.close = async function () {
  await this._redis.quit();
  await this._memory.close();
};
EditorData.prototype.healthCheck = async function () {
  if (this.isConnected()) {
    await this.ping();
    return true;
  }
  return false;
};

EditorData.prototype.lockSave = function (ctx, docId, userId, ttl) {
  return this._saveLock.lockSave(ctx, docId, userId, ttl);
};
EditorData.prototype.unlockSave = function (ctx, docId, userId) {
  return this._saveLock.unlockSave(ctx, docId, userId);
};
EditorData.prototype.lockAuth = function (ctx, docId, userId, ttl) {
  return this._saveLock.lockAuth(ctx, docId, userId, ttl);
};
EditorData.prototype.unlockAuth = function (ctx, docId, userId) {
  return this._saveLock.unlockAuth(ctx, docId, userId);
};

EditorData.prototype.addPresence = function (ctx, docId, userId, userInfo) {
  return this._presence.addPresence(ctx, docId, userId, userInfo);
};
EditorData.prototype.updatePresence = function (ctx, docId, userId) {
  return this._presence.updatePresence(ctx, docId, userId);
};
EditorData.prototype.removePresence = function (ctx, docId, userId) {
  return this._presence.removePresence(ctx, docId, userId);
};
EditorData.prototype.getPresence = function (ctx, docId, connections) {
  return this._presence.getPresence(ctx, docId, connections);
};
EditorData.prototype.getDocumentPresenceExpired = function (now) {
  return this._presence.getDocumentPresenceExpired(now);
};
EditorData.prototype.removePresenceDocument = function (ctx, docId) {
  return this._presence.removePresenceDocument(ctx, docId);
};

// Everything else (Phase 2/3 - block locks, messages, save-state,
// force-save, telemetry): delegate to the memory backend, unchanged.
const DELEGATED_METHODS = [
  'addLocks', 'addLocksNX', 'removeLocks', 'removeAllLocks', 'getLocks',
  'addMessage', 'removeMessages', 'getMessages',
  'setSaved', 'getdelSaved',
  'setForceSave', 'getForceSave', 'checkAndStartForceSave', 'checkAndSetForceSave', 'removeForceSave',
  'addForceSaveTimerNX', 'getForceSaveTimer',
];
for (const method of DELEGATED_METHODS) {
  EditorData.prototype[method] = function (...args) {
    return this._memory[method](...args);
  };
}

// Presence is deliberately NOT cleaned up here. This fires once
// `!hasEditors`, which ignores viewers - a viewer can still be legitimately
// connected when it does, and wiping the presence HASH/ZSET here would
// delete their entry too. The memory backend never touches presence in its
// own cleanDocumentOnExit either (presence there isn't a stored structure
// at all, just derived live from the connections array) - the actual
// "presence is genuinely empty, safe to delete" trigger is a separate call
// site, correctly gated on an empty getPresence result.
EditorData.prototype.cleanDocumentOnExit = async function (ctx, docId) {
  await this._memory.cleanDocumentOnExit(ctx, docId);
  await this._saveLock.cleanup(ctx, docId);
};

module.exports = {
  EditorData,
  // This module doesn't touch telemetry; if editorStatStorage falls back to
  // it (config.js's default when unset), reuse the memory backend's
  // EditorStat unchanged rather than leaving it broken.
  EditorStat: editorDataMemory.EditorStat,
};
