'use strict';

const {encodePair, decodePair, shardIndex} = require('./editorDataRedisKeys');

// A pre-sharded "which (tenant, docId) pairs are due for a global sweep"
// structure - N sorted sets rather than one, so it stays Redis-Cluster-ready
// (a single global structure can't be sharded across hash slots) and so a
// thundering herd of due entries doesn't get claimed and processed in one
// unbounded Lua call.
//
// Built once here so the presence doc-expiry sweep and any future
// force-save timer built on the same pattern share one implementation
// instead of two copies of the same Lua script drifting apart.

// ZRANGEBYSCORE + ZREM in one script so two replicas sweeping at the same
// moment can never both claim (and double-process) the same due entry.
// LIMIT bounds one call's cost against a thundering herd of due entries.
const CLAIM_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
if #due > 0 then
  redis.call('ZREM', KEYS[1], unpack(due))
end
return due
`;

// GET-then-conditionally-SET as two separate round trips would race: two
// concurrent trackers could both read the old (lower) score, both decide
// their own value is the new max, and whichever ZADD lands second would
// silently undo the first. One script instead.
const TRACK_SCRIPT = `
local existing = redis.call('ZSCORE', KEYS[1], ARGV[2])
if not existing or tonumber(existing) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
end
return 1
`;

const CLAIM_BATCH_SIZE = 100;

// `redis`: an ioredis client (commands are registered on it directly - the
// caller owns the client's lifetime, this just adds commands to it).
// `keyPrefix`: e.g. 'ds:presenceDocExp:' - shard index is appended by track/untrack.
// `commandNamePrefix`: must be unique per sweep instance sharing one redis
// client (ioredis commands are registered by name on the client, not scoped
// per call) - two command names are derived from it (claim/track).
function createShardedSweep(redis, keyPrefix, numShards, commandNamePrefix) {
  const claimCommand = `${commandNamePrefix}Claim`;
  const trackCommand = `${commandNamePrefix}Track`;
  redis.defineCommand(claimCommand, {numberOfKeys: 1, lua: CLAIM_SCRIPT});
  redis.defineCommand(trackCommand, {numberOfKeys: 1, lua: TRACK_SCRIPT});

  function shardKey(tenant, docId) {
    return `${keyPrefix}${shardIndex(tenant, docId, numShards)}`;
  }

  return {
    // Bumps this (tenant, docId) pair's tracked score to `expiresAt`, but
    // only if that's later than what's already there - the caller may be
    // one of several independent things (e.g. several connections on one
    // document) each with their own expiry, and the sweep should only fire
    // once the LATEST of them has passed.
    async track(tenant, docId, expiresAt) {
      const key = shardKey(tenant, docId);
      const member = encodePair(tenant, docId);
      await redis[trackCommand](key, expiresAt, member);
    },
    async untrack(tenant, docId) {
      const key = shardKey(tenant, docId);
      const member = encodePair(tenant, docId);
      await redis.zrem(key, member);
    },
    // Returns an array of [tenant, docId] pairs whose tracked score is <= now,
    // removing them from the structure as they're claimed (so a second call
    // never re-returns the same entry).
    async claimExpired(now) {
      const results = [];
      for (let shard = 0; shard < numShards; shard++) {
        const key = `${keyPrefix}${shard}`;
        let due;
        do {
          due = await redis[claimCommand](key, now, CLAIM_BATCH_SIZE);
          for (const member of due) {
            results.push(decodePair(member));
          }
        } while (due.length === CLAIM_BATCH_SIZE);
      }
      return results;
    }
  };
}

module.exports = {createShardedSweep};
