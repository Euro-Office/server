'use strict';

const {buildKey} = require('./editorDataRedisKeys');

// Owner-token locks, not fencing tokens - see REDIS_EDITORDATA.md.

const LOCK_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

const UNLOCK_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then
  return {2, false}
end
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1, current}
end
return {0, current}
`;

// Must stay numerically identical to commondefines.js's c_oAscUnlockRes -
// duplicated to keep this module dependency-free; callers compare directly.
const UNLOCK_RES = {LOCKED: 0, UNLOCKED: 1, EMPTY: 2};

function ttlToMs(ttl) {
  // `ttl` is in seconds at every call site, as in editorDataMemory.js.
  return ttl * 1000;
}

// Caller owns the client's lifetime.
function createSaveLockStore(redis, prefix) {
  redis.defineCommand('saveLockScript', {numberOfKeys: 1, lua: LOCK_SCRIPT});
  redis.defineCommand('saveUnlockScript', {numberOfKeys: 1, lua: UNLOCK_SCRIPT});

  const lockSavePrefix = `${prefix}lockSave:`;
  const lockAuthPrefix = `${prefix}lockAuth:`;

  // Fail closed: an error must come back as a denial, never a throw and
  // never a false grant. buildKey stays inside the try - encodeURIComponent
  // throws on malformed unicode.
  async function lock(keyPrefix, ctx, docId, userId, ttl) {
    try {
      const key = buildKey(keyPrefix, ctx.tenant, docId);
      const res = await redis.saveLockScript(key, userId, ttlToMs(ttl));
      return res === 1;
    } catch (_err) {
      return false;
    }
  }
  // LOCKED, not UNLOCKED, on error: callers only take their "release
  // succeeded" branch on UNLOCKED, and we don't know whether it happened.
  async function unlock(keyPrefix, ctx, docId, userId) {
    try {
      const key = buildKey(keyPrefix, ctx.tenant, docId);
      const [code] = await redis.saveUnlockScript(key, userId);
      if (code === 1) return UNLOCK_RES.UNLOCKED;
      if (code === 0) return UNLOCK_RES.LOCKED;
      return UNLOCK_RES.EMPTY;
    } catch (_err) {
      return UNLOCK_RES.LOCKED;
    }
  }

  return {
    lockSave: (ctx, docId, userId, ttl) => lock(lockSavePrefix, ctx, docId, userId, ttl),
    unlockSave: (ctx, docId, userId) => unlock(lockSavePrefix, ctx, docId, userId),
    lockAuth: (ctx, docId, userId, ttl) => lock(lockAuthPrefix, ctx, docId, userId, ttl),
    unlockAuth: (ctx, docId, userId) => unlock(lockAuthPrefix, ctx, docId, userId),
    async cleanup(ctx, docId) {
      // Safe to swallow: both keys carry their own PX expiry, so a failed DEL
      // only delays removal. Throwing here would abort the caller's remaining
      // cleanup (e.g. unlockWopiDoc) on a transient blip.
      try {
        await redis.del(buildKey(lockSavePrefix, ctx.tenant, docId), buildKey(lockAuthPrefix, ctx.tenant, docId));
      } catch (_err) {
        /* see above */
      }
    }
  };
}

module.exports = {createSaveLockStore, UNLOCK_RES};
