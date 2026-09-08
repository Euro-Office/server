'use strict';

const {encodePair, decodePair, shardIndex} = require('./editorDataRedisKeys');

// "Which (tenant, docId) pairs are due for a sweep", spread over N sorted
// sets. See REDIS_EDITORDATA.md for why it's sharded.

// One script, so two replicas sweeping concurrently can't both claim the
// same entry. LIMIT bounds a single call against a large backlog.
const CLAIM_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
if #due > 0 then
  redis.call('ZREM', KEYS[1], unpack(due))
end
return due
`;

// One script: split into ZSCORE-then-ZADD round trips, two concurrent
// trackers could both read the old score and the later ZADD would undo the
// earlier one.
const TRACK_SCRIPT = `
local existing = redis.call('ZSCORE', KEYS[1], ARGV[2])
if not existing or tonumber(existing) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
end
return 1
`;

const CLAIM_BATCH_SIZE = 100;

// `commandNamePrefix` must be unique per sweep instance sharing one client -
// ioredis registers defined commands by name on the client itself.
function createShardedSweep(redis, keyPrefix, numShards, commandNamePrefix) {
  const claimCommand = `${commandNamePrefix}Claim`;
  const trackCommand = `${commandNamePrefix}Track`;
  redis.defineCommand(claimCommand, {numberOfKeys: 1, lua: CLAIM_SCRIPT});
  redis.defineCommand(trackCommand, {numberOfKeys: 1, lua: TRACK_SCRIPT});

  function shardKey(tenant, docId) {
    return `${keyPrefix}${shardIndex(tenant, docId, numShards)}`;
  }

  return {
    // Several connections on one document each track their own expiry; the
    // sweep should fire on the latest, hence forwards-only.
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
    // [tenant, docId] pairs due at `now`.
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
