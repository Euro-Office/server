'use strict';

const {buildKey} = require('./editorDataRedisKeys');
const {createShardedSweep} = require('./editorDataRedisShardedSweep');

// A HASH per document for connection info, a companion SORTED SET for
// per-connection expiry, and a sharded sweep of documents with no live
// presence left (feeds gc.js). See REDIS_EDITORDATA.md.

// One script so a reader can't see the HASH and ZSET disagree. The PEXPIREs
// are a backstop: docExpSweep.track() is a separate round trip that can fail
// after this lands, and nothing else would ever delete these keys.
const WRITE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 1
`;

const REMOVE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// One script: as separate HGET-then-ZADD round trips, a concurrent remove
// landing between them would be silently undone. Re-PEXPIREs so a
// heartbeating connection keeps pushing the backstop out.
const REFRESH_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if not existing then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`;

const DOC_EXP_SHARDS = 16;

// Backstop only - a heartbeating entry must never reach it.
const NATIVE_TTL_MULTIPLIER = 3;

// `ttlSeconds`: services.CoAuthoring.expire.presence. `memoryFallback`: an
// editorDataMemory.EditorData, reused for the fail-open degrade path.
function createPresenceStore(redis, prefix, ttlSeconds, memoryFallback) {
  redis.defineCommand('presenceWriteScript', {numberOfKeys: 2, lua: WRITE_SCRIPT});
  redis.defineCommand('presenceRemoveScript', {numberOfKeys: 2, lua: REMOVE_SCRIPT});
  redis.defineCommand('presenceRefreshScript', {numberOfKeys: 2, lua: REFRESH_SCRIPT});

  const presencePrefix = `${prefix}presence:`;
  const presenceExpPrefix = `${prefix}presenceExp:`;
  const docExpSweep = createShardedSweep(redis, `${prefix}presenceDocExp:`, DOC_EXP_SHARDS, 'presenceDocExp');

  async function writeAndTrack(ctx, docId, userId, userInfo) {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
    const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
    await redis.presenceWriteScript(hashKey, expKey, userId, userInfo, expiresAt, ttlSeconds * NATIVE_TTL_MULTIPLIER * 1000);
    try {
      await docExpSweep.track(ctx.tenant, docId, expiresAt);
    } catch (_err) {
      // The write landed; only sweep-tracking failed. Don't fall the whole
      // call back to memory - the next heartbeat retries this.
    }
  }

  // Fail open: wrong presence is an acceptable degrade, an unopenable
  // document is not.
  async function failOpen(fn, fallback) {
    try {
      return await fn();
    } catch (_err) {
      return fallback();
    }
  }

  return {
    // `userId` is `conn.user.id`, already per-connection-unique in this
    // codebase (see utils.getIndexFromUserId), so it works as the member.
    async addPresence(ctx, docId, userId, userInfo) {
      return failOpen(
        () => writeAndTrack(ctx, docId, userId, userInfo),
        () => memoryFallback.addPresence(ctx, docId, userId, userInfo)
      );
    },

    // Refresh only - the interface passes no fresh info blob here. Returns
    // whether there was anything to refresh: this store can't rebuild the
    // blob itself, so a caller whose entry expired has to re-add it.
    async updatePresence(ctx, docId, userId) {
      return failOpen(
        async () => {
          const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
          const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
          const expiresAt = Date.now() + ttlSeconds * 1000;
          const refreshed = await redis.presenceRefreshScript(hashKey, expKey, userId, expiresAt, ttlSeconds * NATIVE_TTL_MULTIPLIER * 1000);
          if (refreshed !== 1) {
            return false;
          }
          try {
            await docExpSweep.track(ctx.tenant, docId, expiresAt);
          } catch (_err) {
            // As in writeAndTrack.
          }
          return true;
        },
        () => memoryFallback.updatePresence(ctx, docId, userId)
      );
    },

    async removePresence(ctx, docId, userId) {
      return failOpen(
        async () => {
          const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
          const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
          await redis.presenceRemoveScript(hashKey, expKey, userId);
        },
        () => memoryFallback.removePresence(ctx, docId, userId)
      );
    },

    async getPresence(ctx, docId, connections) {
      return failOpen(
        async () => {
          const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
          const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
          const now = Date.now();
          const liveIds = await redis.zrangebyscore(expKey, now, '+inf');
          if (0 === liveIds.length) {
            return [];
          }
          const values = await redis.hmget(hashKey, ...liveIds);
          return values.filter(v => null != v);
        },
        async () => {
          // This sees only local connections, so a "zero" here is a guess,
          // not a fact. DocsCoServer.js's hasEditors() reads the marker to
          // avoid releasing locks on it.
          const hvals = await memoryFallback.getPresence(ctx, docId, connections);
          hvals.presenceUnknown = true;
          return hvals;
        }
      );
    },

    async getDocumentPresenceExpired(now) {
      return failOpen(
        () => docExpSweep.claimExpired(now),
        () => memoryFallback.getDocumentPresenceExpired(now)
      );
    },

    async removePresenceDocument(ctx, docId) {
      return failOpen(
        async () => {
          const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
          const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
          await redis.del(hashKey, expKey);
          await docExpSweep.untrack(ctx.tenant, docId);
        },
        () => memoryFallback.removePresenceDocument(ctx, docId)
      );
    }
  };
}

module.exports = {createPresenceStore};
