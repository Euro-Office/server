/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const CLAIM_SAVED_SCRIPT = `
-- Claim the saved status instead of deleting it before the caller has had a
-- chance to observe the reply.  The claim is the durable operation record and
-- has its own lease.  This bounds abandoned state while leaving enough time
-- for a retry after a lost response or worker crash.
local currentClaim = redis.call('HGET', KEYS[2], 'id')
if currentClaim then
  local claimState = redis.call('HGET', KEYS[2], 'state')
  local claimedValue = redis.call('HGET', KEYS[2], 'value')
  -- Claims written before leases were introduced have no TTL.  Migrate them
  -- when first observed without extending claims that already have a lease.
  if redis.call('TTL', KEYS[2]) < 0 then
    redis.call('EXPIRE', KEYS[2], ARGV[2])
  end

  if claimState == 'resolved' then
    -- A duplicate delivery of the resolved operation must not consume a
    -- newer saved value.  A different operation may claim that value.
    if claimedValue then
      return {'unknown'}
    end
    if currentClaim == ARGV[1] then
      return {'absent'}
    end
    local value = redis.call('GET', KEYS[1])
    if not value then
      return {'absent'}
    end
    redis.call('HSET', KEYS[2], 'id', ARGV[1], 'value', value, 'state', 'pending')
    redis.call('EXPIRE', KEYS[2], ARGV[2])
    redis.call('DEL', KEYS[1])
    return {'value', value}
  end

  if (not claimState or claimState == 'pending') and currentClaim == ARGV[1] then
    if claimedValue then
      return {'value', claimedValue}
    end
    return {'unknown'}
  end
  return {'unknown'}
end

local value = redis.call('GET', KEYS[1])
if not value then
  return {'absent'}
end

redis.call('HSET', KEYS[2], 'id', ARGV[1], 'value', value, 'state', 'pending')
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
return {'value', value}
`;

const ACK_SAVED_SCRIPT = `
local currentClaim = redis.call('HGET', KEYS[1], 'id')
if not currentClaim or currentClaim ~= ARGV[1] then
  -- The claim is unknown, expired, or belongs to another operation.
  return 0
end

local claimState = redis.call('HGET', KEYS[1], 'state')
if claimState == 'resolved' then
  -- A resolved marker is retained under the original claim lease so a
  -- response-loss retry can safely acknowledge the same operation again.
  if redis.call('HEXISTS', KEYS[1], 'value') == 1 then
    return -1
  end
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  return 2
end

-- Claims created before the state field was introduced are still valid as
-- pending claims.  Any other shape is malformed and must fail closed.
if (not claimState or claimState == 'pending') and redis.call('HEXISTS', KEYS[1], 'value') == 1 then
  if redis.call('TTL', KEYS[1]) < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  redis.call('HSET', KEYS[1], 'state', 'resolved')
  redis.call('HDEL', KEYS[1], 'value')
  return 1
end

return -1
`;

module.exports = {CLAIM_SAVED_SCRIPT, ACK_SAVED_SCRIPT};
