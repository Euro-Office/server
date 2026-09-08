'use strict';

const { buildKey } = require('./editorDataRedisKeys');

// lockSave/unlockSave/lockAuth/unlockAuth. Owner-token locks (reentrant
// acquire-or-refresh by the same owner, stateless release), not true
// Kleppmann fencing tokens: a lock holder proves it once acquired the lock,
// not that it still holds it at the moment a write actually lands. Known,
// currently-accepted gap - not evaluated against the write path here.

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

// Duplicated from commondefines.js's c_oAscUnlockRes rather than requiring
// that module, to keep this module dependency-free. Must stay numerically
// identical to it - callers compare against these values directly.
const UNLOCK_RES = { LOCKED: 0, UNLOCKED: 1, EMPTY: 2 };

function ttlToMs(ttl) {
  // The interface's `ttl` is in seconds everywhere it's called (matches
  // editorDataMemory.js's own `now + ttl * 1000`) - a unit mismatch here
  // would silently make every lock's real expiry 1000x off from what the
  // caller asked for.
  return ttl * 1000;
}

// `redis`: an ioredis client (commands are registered on it directly - the
// caller owns the client's lifetime). `prefix`: the shared `ds:`-style
// config prefix; this module owns the `lockSave:`/`lockAuth:` sub-namespaces.
function createSaveLockStore(redis, prefix) {
  redis.defineCommand('saveLockScript', { numberOfKeys: 1, lua: LOCK_SCRIPT });
  redis.defineCommand('saveUnlockScript', { numberOfKeys: 1, lua: UNLOCK_SCRIPT });

  const lockSavePrefix = `${prefix}lockSave:`;
  const lockAuthPrefix = `${prefix}lockAuth:`;

  // Fail-closed, not fail-open. A Redis error or timeout must come back as
  // a denial (`false`) - the client already knows how to handle a denied
  // lock (retry), but has no way to handle a lock that looked granted while
  // never actually being held. Relies on the composition root's
  // `commandTimeout` to make "Redis is unreachable" fail promptly rather
  // than hang the caller indefinitely.
  async function lock(keyPrefix, ctx, docId, userId, ttl) {
    // buildKey (encodeURIComponent under the hood) must be inside the try:
    // it can throw on malformed input (e.g. a lone UTF-16 surrogate in
    // docId/tenant) just as easily as the Redis call can fail, and a
    // "fail-closed, never throw" store can't have an exception path that
    // isn't actually caught.
    try {
      const key = buildKey(keyPrefix, ctx.tenant, docId);
      const res = await redis.saveLockScript(key, userId, ttlToMs(ttl));
      return res === 1;
    } catch (_err) {
      return false;
    }
  }
  // On a Redis error, deliberately do not report UNLOCKED - the caller
  // (checkEndAuthLock, saveChanges's cleanup) only takes its "release
  // succeeded" branch on that exact value, and we genuinely don't know
  // whether the unlock happened. LOCKED is the closest honest answer:
  // "not confirmed released."
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
      // Unlike lock()/unlock(), a failure here is safe to swallow rather
      // than report: both keys always carry their own PX expiry from
      // LOCK_SCRIPT, so a failed DEL just means they self-expire on their
      // existing TTL instead of being removed early. Left uncaught, this
      // would instead throw up through cleanDocumentOnExit and abort
      // whatever the caller runs after it (e.g. unlockWopiDoc) on nothing
      // worse than a transient Redis blip.
      try {
        await redis.del(
          buildKey(lockSavePrefix, ctx.tenant, docId),
          buildKey(lockAuthPrefix, ctx.tenant, docId)
        );
      } catch (_err) {
        // Intentionally swallowed - see above.
      }
    },
  };
}

module.exports = { createSaveLockStore, UNLOCK_RES };
