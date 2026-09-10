'use strict';
const config = require('config');
const Redis = require('ioredis');
const {createRedisClient} = require('./editorDataRedisClient');
const editorDataMemory = require('./editorDataMemory');
const {createSaveLockStore} = require('./editorDataRedisSaveLock');
const {createPresenceStore} = require('./editorDataRedisPresence');
const {createFailureReporter} = require('./editorDataRedisReport');

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

  // Connection errors never reach the stores' catch blocks - ioredis emits
  // them as 'error' events - and with no listener it prints
  // "[ioredis] Unhandled error event" plus a stack straight to stderr, once
  // per retry, for the length of an outage. That bypasses both the logger
  // and the throttle the stores use. Route them through the same reporter.
  this._connectionReport = createFailureReporter('editorDataRedis.connection');
  this._redis.on('error', err => this._connectionReport.failure(null, 'connection', err));
  this._redis.on('ready', () => this._connectionReport.success(null));
  // A cluster raises 'error' only when every node has failed; a single
  // unreachable master arrives as 'node error'. Without this, the topology
  // where one node is down - fail-closed for every document on its slots -
  // produces no line naming the cause at all.
  if (this._redis instanceof Redis.Cluster) {
    this._redis.on('node error', err => this._connectionReport.failure(null, 'node connection', err));
  }

  this._saveLock = createSaveLockStore(this._redis, prefix);
  this._presence = createPresenceStore(this._redis, prefix, config.get('services.CoAuthoring.expire.presence'), this._memory);
}

// Long enough for a healthy Redis on the same network, short enough that a
// dead one does not hold up the startup chain behind it.
const CONNECT_TIMEOUT_MS = 3000;

EditorData.prototype.connect = async function () {
  await this._memory.connect();
  // `iooptions.lazyConnect: true` is the shipped default, which parks the
  // client at status "wait" until some real command arrives - so
  // isConnected()/healthCheck() would never turn true on an idle replica.
  //
  // Awaited, because the offline queue is disabled: commands issued before
  // the client is ready are rejected outright rather than held, so handing
  // control back while still connecting would deny the first locks of a
  // freshly started replica. Bounded and swallowed, because Redis being
  // down at startup must not stop the process booting - it must fail
  // closed, which it does.
  // 'end' is a closed client: no 'ready' is coming, so waiting for one just
  // burns the timeout.
  if (this._redis.status === 'ready' || this._redis.status === 'end') {
    return;
  }

  // "not ready", not "at wait": with lazyConnect off the constructor has
  // already started connecting, and returning here would hand back a client
  // whose first commands are still rejected.
  let timer;
  let onReady;
  const ready = new Promise(resolve => {
    onReady = resolve;
    this._redis.once('ready', onReady);
  });
  try {
    // connect() rejects unless the client is parked, and rejects on the
    // first failed attempt - so a refused connection returns straight away
    // and the timer only covers a connect that hangs.
    const racers = [
      ready,
      new Promise(resolve => {
        timer = setTimeout(resolve, CONNECT_TIMEOUT_MS);
      })
    ];
    if (this._redis.status === 'wait') {
      racers.push(this._redis.connect().catch(() => {}));
    }
    await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    this._redis.removeListener('ready', onReady);
  }
};
EditorData.prototype.isConnected = function () {
  return this._redis.status === 'ready' && this._memory.isConnected();
};
EditorData.prototype.ping = async function () {
  return this._redis.ping();
};
EditorData.prototype.close = async function () {
  // QUIT is itself a command, so with the offline queue disabled it is
  // rejected on a client that never reached a server. Closing must not
  // depend on the connection having worked.
  try {
    await this._redis.quit();
  } catch {
    this._redis.disconnect();
  }
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
