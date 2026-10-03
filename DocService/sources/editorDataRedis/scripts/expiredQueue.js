/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {REDIS_TIME_MILLIS} = require('./helpers');

const POP_EXPIRED_SCRIPT = `
${REDIS_TIME_MILLIS}
-- POP_EXPIRED is a bounded, at-least-once claim.  The caller must acknowledge
-- each returned member after processing it.  Until then, the member stays in
-- the lease set and is reclaimed after the lease timestamp if the response or
-- worker is lost.  ARGV[5] selects Redis TIME for document presence; the
-- force-save queue retains its explicit caller-provided comparison time. All
-- keys use the same editor:index shard hash tag, so the operation is atomic
-- on both standalone Redis and Redis Cluster.
local values = {}
local useRedisTime = ARGV[5] == 'redis-time'
local now = useRedisTime and redisTimeMillis() or tonumber(ARGV[1])
local limit = tonumber(ARGV[3])
local leaseUntil = useRedisTime and tostring(now + tonumber(ARGV[2])) or ARGV[2]
local claimId = ARGV[4]

local function claim(member)
  redis.call('ZADD', KEYS[2], leaseUntil, member)
  redis.call('HSET', KEYS[3], member, claimId)
  table.insert(values, member)
end

-- Reclaim timed-out work first.  If a newer expiry was written while the
-- member was leased, leave that newer source entry authoritative.
local leased = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', '0', limit)
for _, member in ipairs(leased) do
  if #values < limit then
    redis.call('ZREM', KEYS[2], member)
    if not redis.call('ZSCORE', KEYS[1], member) then
      claim(member)
    else
      redis.call('HDEL', KEYS[3], member)
    end
  end
end

-- Fill the remaining slots from the source index.  Moving the member and
-- recording its token happen in this same script, so no concurrent worker can
-- claim the same source entry.
local remaining = limit - #values
if remaining > 0 then
  local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', '0', remaining)
  for _, member in ipairs(expired) do
    redis.call('ZREM', KEYS[1], member)
    claim(member)
  end
end
return values
`;

const ACK_EXPIRED_SCRIPT = `
if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[1] then
  return 0
end
redis.call('HDEL', KEYS[2], ARGV[2])
return redis.call('ZREM', KEYS[1], ARGV[2])
`;

module.exports = {POP_EXPIRED_SCRIPT, ACK_EXPIRED_SCRIPT};
