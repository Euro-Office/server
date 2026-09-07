'use strict';

const { buildKey } = require('./editorDataRedisKeys');
const { createShardedSweep } = require('./editorDataRedisShardedSweep');

// A HASH per document for connection-info payloads, a companion SORTED SET
// for per-connection expiry, and a sharded global sweep (the same pattern
// editorDataRedisShardedSweep.js also backs the force-save timer with) for
// "which documents have no live presence left at all" - feeds gc.js's
// cleanup sweep.

// HSET (per-connection data) + ZADD (per-connection expiry) in one script,
// so a reader can never observe one structure updated without the other.
const WRITE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`;

// HDEL + ZREM in one script, same atomicity reasoning as the write side.
const REMOVE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// A GET-then-conditional-SET across two round trips (HGET, then decide
// whether to write) races: the connection can be removed by another caller
// between the two, and the refresh silently resurrects it. One script
// instead: refresh only if the connection is still on record, atomically.
const REFRESH_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if not existing then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;

const DOC_EXP_SHARDS = 16; // Matches editorDataRedisShardedSweep.js's other user (the force-save timer).

// `redis`: an ioredis client (commands are registered on it directly).
// `prefix`: the shared `ds:`-style config prefix.
// `ttlSeconds`: services.CoAuthoring.expire.presence.
// `memoryFallback`: an editorDataMemory.EditorData instance - the fail-open
// degrade path on a Redis error reuses its local-connections-only behavior
// rather than reimplementing it.
function createPresenceStore(redis, prefix, ttlSeconds, memoryFallback) {
  redis.defineCommand('presenceWriteScript', { numberOfKeys: 2, lua: WRITE_SCRIPT });
  redis.defineCommand('presenceRemoveScript', { numberOfKeys: 2, lua: REMOVE_SCRIPT });
  redis.defineCommand('presenceRefreshScript', { numberOfKeys: 2, lua: REFRESH_SCRIPT });

  const presencePrefix = `${prefix}presence:`;
  const presenceExpPrefix = `${prefix}presenceExp:`;
  const docExpSweep = createShardedSweep(redis, `${prefix}presenceDocExp:`, DOC_EXP_SHARDS, 'presenceDocExp');

  async function writeAndTrack(ctx, docId, userId, userInfo) {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
    const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
    await redis.presenceWriteScript(hashKey, expKey, userId, userInfo, expiresAt);
    await docExpSweep.track(ctx.tenant, docId, expiresAt);
  }

  // Fail open on any Redis error, everywhere in this store - the failure
  // mode is presence being wrong (a joiner waits when it shouldn't, or vice
  // versa), not silent data loss, so falling back to the memory backend's
  // own no-op/empty behavior is an acceptable degrade. Letting an error
  // propagate here would instead turn a Redis outage into documents being
  // unopenable.
  async function failOpen(fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      return fallback();
    }
  }

  return {
    // `userId` here is the value the interface actually passes at every call
    // site (`conn.user.id`) - already per-connection-unique in this
    // codebase's convention (a synthesized original-id+index value, not a
    // raw account id; see `utils.getIndexFromUserId`), so it serves
    // correctly as the per-connection HASH/ZSET member.
    async addPresence(ctx, docId, userId, userInfo) {
      return failOpen(
        () => writeAndTrack(ctx, docId, userId, userInfo),
        () => memoryFallback.addPresence(ctx, docId, userId, userInfo)
      );
    },

    // Refresh only - re-send the same info blob already on record, since the
    // interface doesn't pass a fresh one here (matches `endAuth`'s existing
    // conditional dispatch).
    async updatePresence(ctx, docId, userId) {
      return failOpen(async () => {
        const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
        const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
        const expiresAt = Date.now() + ttlSeconds * 1000;
        const refreshed = await redis.presenceRefreshScript(hashKey, expKey, userId, expiresAt);
        if (refreshed === 1) {
          await docExpSweep.track(ctx.tenant, docId, expiresAt);
        }
      }, () => memoryFallback.updatePresence(ctx, docId, userId));
    },

    async removePresence(ctx, docId, userId) {
      return failOpen(async () => {
        const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
        const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
        await redis.presenceRemoveScript(hashKey, expKey, userId);
      }, () => memoryFallback.removePresence(ctx, docId, userId));
    },

    async getPresence(ctx, docId, connections) {
      return failOpen(async () => {
        const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
        const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
        const now = Date.now();
        const liveIds = await redis.zrangebyscore(expKey, now, '+inf');
        if (0 === liveIds.length) {
          return [];
        }
        const values = await redis.hmget(hashKey, ...liveIds);
        return values.filter((v) => null != v);
      }, () => memoryFallback.getPresence(ctx, docId, connections));
    },

    async getDocumentPresenceExpired(now) {
      return failOpen(
        () => docExpSweep.claimExpired(now),
        () => memoryFallback.getDocumentPresenceExpired(now)
      );
    },

    async removePresenceDocument(ctx, docId) {
      return failOpen(async () => {
        const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
        const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
        await redis.del(hashKey, expKey);
        await docExpSweep.untrack(ctx.tenant, docId);
      }, () => memoryFallback.removePresenceDocument(ctx, docId));
    },
  };
}

module.exports = { createPresenceStore };
