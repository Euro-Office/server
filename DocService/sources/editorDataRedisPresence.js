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
// Also PEXPIREs both keys - docExpSweep.track() (called separately, right
// after this script, not inside it) is a second round trip that can fail
// after this one succeeds, and neither key otherwise has any native Redis
// expiry. Without this, that failure mode leaves a live, cross-replica-
// visible presence entry with no path to ever being deleted. The native
// TTL is a backstop against that, independent of the sweep; getPresence's
// own zrangebyscore filtering (not this TTL) is what makes an entry stop
// being *seen* as live, well before this backstop would ever fire under
// normal heartbeat cadence.
const WRITE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
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
// Also refreshes both keys' native TTL (see WRITE_SCRIPT) - a
// continuously-heartbeating connection must keep pushing that backstop
// out, not just the one set at the original write.
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

const DOC_EXP_SHARDS = 16; // Matches editorDataRedisShardedSweep.js's other user (the force-save timer).

// The native Redis TTL above is only a backstop for when docExpSweep never
// gets to a document; a legitimate, continuously-heartbeating entry must
// never realistically hit it. Generous multiple of ttlSeconds so it doesn't.
const NATIVE_TTL_MULTIPLIER = 3;

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
    await redis.presenceWriteScript(hashKey, expKey, userId, userInfo, expiresAt, ttlSeconds * NATIVE_TTL_MULTIPLIER * 1000);
    try {
      await docExpSweep.track(ctx.tenant, docId, expiresAt);
    } catch (_err) {
      // The write above already landed and is genuinely live and
      // cross-replica-visible (and self-expires regardless, via the
      // PEXPIRE inside presenceWriteScript) - a failure here only means
      // this write isn't yet known to the doc-expiry sweep. Swallow
      // rather than let it fail the whole call into the memory-backend
      // fallback, which would wrongly tell the caller nothing reached
      // Redis. The next successful addPresence/updatePresence heartbeat
      // for this connection retries this call and self-heals it.
    }
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
    } catch (_err) {
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
    // conditional dispatch). Returns whether the entry was actually there to
    // refresh - since this store has no way to reconstruct the connection's
    // info blob itself, a caller whose heartbeat stalled long enough for the
    // native TTL backstop to have deleted the entry (see WRITE_SCRIPT) must
    // see that and re-add it via addPresence, or that connection's presence
    // never comes back.
    async updatePresence(ctx, docId, userId) {
      return failOpen(async () => {
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
          // Same reasoning as writeAndTrack: the refresh itself already
          // landed in Redis - don't let a sweep-tracking failure alone
          // fall this call back to the memory backend.
        }
        return true;
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
