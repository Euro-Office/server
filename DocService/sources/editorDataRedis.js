'use strict';
const config = require('config');
const {createRedisClient} = require('./editorDataRedisClient');
const editorDataMemory = require('./editorDataMemory');
const {createSaveLockStore} = require('./editorDataRedisSaveLock');
const {createPresenceStore} = require('./editorDataRedisPresence');

// Composition root for the Redis-backed save/auth locks and presence: owns
// the connection and the memory-backend delegate, wires the two stores
// against them. Everything not ported still delegates to editorDataMemory.
// See REDIS_EDITORDATA.md.

function EditorData() {
  this._memory = new editorDataMemory.EditorData();

  const redisCfg = config.get('services.CoAuthoring.redis');
  const prefix = redisCfg.prefix || 'ds:';

  // Standalone, sentinel or cluster, per services.CoAuthoring.redis.mode.
  // ioredis overrides live under `iooptions`; the sibling `options` block is
  // the legacy node-redis one and does nothing here.
  this._redis = createRedisClient(redisCfg);

  this._saveLock = createSaveLockStore(this._redis, prefix);
  this._presence = createPresenceStore(this._redis, prefix, config.get('services.CoAuthoring.expire.presence'), this._memory);
}

EditorData.prototype.connect = async function () {
  await this._memory.connect();
  // `iooptions.lazyConnect: true` is the shipped default, which parks the
  // client at status "wait" until some real command arrives - so
  // isConnected()/healthCheck() would never turn true on an idle replica.
  // Not awaited, errors ignored: a Redis outage at startup must not block
  // the rest of the startup chain, and ioredis retries on its own.
  if (this._redis.status === 'wait') {
    this._redis.connect().catch(() => {});
  }
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

const DELEGATED_METHODS = [
  'addLocks',
  'addLocksNX',
  'removeLocks',
  'removeAllLocks',
  'getLocks',
  'addMessage',
  'removeMessages',
  'getMessages',
  'setSaved',
  'getdelSaved',
  'setForceSave',
  'getForceSave',
  'checkAndStartForceSave',
  'checkAndSetForceSave',
  'removeForceSave',
  'addForceSaveTimerNX',
  'getForceSaveTimer'
];
for (const method of DELEGATED_METHODS) {
  EditorData.prototype[method] = function (...args) {
    return this._memory[method](...args);
  };
}

// Deliberately does not touch presence: this fires once `!hasEditors`, which
// ignores viewers, so a viewer may still be connected. The "presence is
// genuinely empty" cleanup is a separate call site.
EditorData.prototype.cleanDocumentOnExit = async function (ctx, docId) {
  await this._memory.cleanDocumentOnExit(ctx, docId);
  await this._saveLock.cleanup(ctx, docId);
};

module.exports = {
  EditorData,
  // Reused unchanged - editorStatStorage falls back to this module when unset.
  EditorStat: editorDataMemory.EditorStat
};
