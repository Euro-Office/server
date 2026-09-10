'use strict';

const {buildKey} = require('./editorDataRedisKeys');
const {createShardedSweep} = require('./editorDataRedisShardedSweep');
const {createFailureReporter} = require('./editorDataRedisReport');

// A HASH per document for connection info, a companion SORTED SET for
// per-connection expiry, and a sharded sweep of documents with no live
// presence left (feeds gc.js). See REDIS_EDITORDATA.md.

// One script so a reader can't see the HASH and ZSET disagree. The PEXPIREs
// are a backstop: docExpSweep.track() is a separate round trip that can fail
// after this lands, and nothing else would ever delete these keys.
// Prunes stale members. getPresence filters expired members out of the
// read, so nothing else ever removes them: a document that always has at
// least one heartbeating connection is never swept, and every ungraceful
// disconnect leaves a member behind for good. userId is per-connection, so
// a user reconnecting on a flaky link strands a new entry each time.
// LIMIT bounds the unpack - an unbounded one hits Lua's C-stack ceiling.
// Runs last in both scripts, after the caller's own score has been pushed
// into the future: pruning first could HDEL the caller's field while the
// ZADD puts its member back, leaving a member with no hash entry behind it.
const PRUNE_STALE = `
local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[5], 'LIMIT', 0, 100)
if #stale > 0 then
  redis.call('ZREM', KEYS[2], unpack(stale))
  redis.call('HDEL', KEYS[1], unpack(stale))
end
`;

const WRITE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
${PRUNE_STALE}
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
${PRUNE_STALE.replace(/ARGV\[5\]/g, 'ARGV[4]')}
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

  const report = createFailureReporter('editorDataRedisPresence');
  // The doc-expiry sweep gets its own reporter. Sharing one made the throttle
  // flap: a failing docExpSweep.track() inside a *successful* presence write
  // logged a failure, then failOpen logged "recovered" on the way out, so a
  // partial outage produced two lines per heartbeat instead of one per minute.
  const sweepReport = createFailureReporter('editorDataRedisPresence.docExpSweep');

  const presencePrefix = `${prefix}presence:`;
  const presenceExpPrefix = `${prefix}presenceExp:`;
  const docExpSweep = createShardedSweep(redis, `${prefix}presenceDocExp:`, DOC_EXP_SHARDS, 'presenceDocExp');

  async function writeAndTrack(ctx, docId, userId, userInfo) {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
    const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
    await redis.presenceWriteScript(hashKey, expKey, userId, userInfo, expiresAt, ttlSeconds * NATIVE_TTL_MULTIPLIER * 1000, now);
    try {
      await docExpSweep.track(ctx.tenant, docId, expiresAt);
      sweepReport.success(ctx);
    } catch (err) {
      // The write landed; only sweep-tracking failed. Don't fall the whole
      // call back to memory - the next heartbeat retries this. Still worth
      // reporting: if it never succeeds the document relies on its native
      // TTL backstop alone, which nothing else would reveal.
      sweepReport.failure(ctx, 'track', err);
    }
  }

  // Fail open: wrong presence is an acceptable degrade, an unopenable
  // document is not.
  async function failOpen(ctx, operation, fn, fallback, opt_report) {
    const reporter = opt_report || report;
    try {
      const res = await fn();
      reporter.success(ctx);
      return res;
    } catch (err) {
      reporter.failure(ctx, operation, err);
      return fallback();
    }
  }

  return {
    // `userId` is `conn.user.id`, already per-connection-unique in this
    // codebase (see utils.getIndexFromUserId), so it works as the member.
    async addPresence(ctx, docId, userId, userInfo) {
      return failOpen(
        ctx,
        'addPresence',
        () => writeAndTrack(ctx, docId, userId, userInfo),
        () => memoryFallback.addPresence(ctx, docId, userId, userInfo)
      );
    },

    // Refresh only - the interface passes no fresh info blob here. Returns
    // whether there was anything to refresh: this store can't rebuild the
    // blob itself, so a caller whose entry expired has to re-add it.
    async updatePresence(ctx, docId, userId) {
      return failOpen(
        ctx,
        'updatePresence',
        async () => {
          const hashKey = buildKey(presencePrefix, ctx.tenant, docId);
          const expKey = buildKey(presenceExpPrefix, ctx.tenant, docId);
          const now = Date.now();
          const expiresAt = now + ttlSeconds * 1000;
          const refreshed = await redis.presenceRefreshScript(hashKey, expKey, userId, expiresAt, ttlSeconds * NATIVE_TTL_MULTIPLIER * 1000, now);
          if (refreshed !== 1) {
            return false;
          }
          try {
            await docExpSweep.track(ctx.tenant, docId, expiresAt);
            sweepReport.success(ctx);
          } catch (err) {
            // As in writeAndTrack.
            sweepReport.failure(ctx, 'track', err);
          }
          return true;
        },
        () => memoryFallback.updatePresence(ctx, docId, userId)
      );
    },

    async removePresence(ctx, docId, userId) {
      return failOpen(
        ctx,
        'removePresence',
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
        ctx,
        'getPresence',
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
          // not a fact. DocsCoServer.js's isPresenceUnreliable() gates every
          // reader that would act on an absence.
          const hvals = await memoryFallback.getPresence(ctx, docId, connections);
          hvals.presenceUnknown = true;
          return hvals;
        }
      );
    },

    async getDocumentPresenceExpired(now) {
      return failOpen(
        null,
        'claimExpired',
        () => docExpSweep.claimExpired(now),
        () => memoryFallback.getDocumentPresenceExpired(now),
        sweepReport
      );
    },

    async removePresenceDocument(ctx, docId) {
      return failOpen(
        ctx,
        'removePresenceDocument',
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
