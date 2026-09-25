/*
 * (c) Copyright Ascensio System SIA 2010-2025
 *
 * This program is a free software product and is distributed under the terms
 * of the GNU Affero General Public License (AGPL) version 3.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

'use strict';

const LOCK_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (not current) or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

const UNLOCK_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[3])
end
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return tonumber(ARGV[2])
end
return tonumber(ARGV[4])
`;

const ADD_PRESENCE_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;

const UPDATE_PRESENCE_SCRIPT = `
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

const GET_PRESENCE_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
return redis.call('HVALS', KEYS[2])
`;

const REMOVE_PRESENCE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return redis.call('HLEN', KEYS[2])
`;

const PREPARE_PRESENCE_REMOVAL_SCRIPT = `
if redis.call('HLEN', KEYS[2]) > 0 then
  return {0, ''}
end
local version = redis.call('GET', KEYS[3]) or ''
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {1, version}
`;

const REMOVE_DOCUMENT_INDEX_SCRIPT = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then
  return 0
end
if ARGV[2] ~= '' and tonumber(score) == tonumber(ARGV[2]) then
  return redis.call('ZREM', KEYS[1], ARGV[1])
end
if ARGV[2] == '' and tonumber(score) <= tonumber(ARGV[3]) then
  return redis.call('ZREM', KEYS[1], ARGV[1])
end
return 0
`;

const POP_EXPIRED_SCRIPT = `
-- POP_EXPIRED is a bounded, at-least-once claim.  The caller must acknowledge
-- each returned member after processing it.  Until then, the member stays in
-- the lease set and is reclaimed after ARGV[2] if the response or worker is
-- lost.  All keys use the editor:index hash tag, so the operation is atomic
-- on both standalone Redis and Redis Cluster.
local values = {}
local limit = tonumber(ARGV[3])
local leaseUntil = ARGV[2]
local claimId = ARGV[4]

local function claim(member)
  redis.call('ZADD', KEYS[2], leaseUntil, member)
  redis.call('HSET', KEYS[3], member, claimId)
  table.insert(values, member)
end

-- Reclaim timed-out work first.  If a newer expiry was written while the
-- member was leased, leave that newer source entry authoritative.
local leased = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', '0', limit)
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
  local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', '0', remaining)
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

const ADD_LOCKS_SCRIPT = `
for i = 1, #ARGV - 1, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
if #ARGV > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
end
return 1
`;

const ADD_LOCKS_NX_SCRIPT = `
local conflict = {}
for i = 1, #ARGV - 1, 2 do
  if redis.call('HEXISTS', KEYS[1], ARGV[i]) == 1 then
    table.insert(conflict, ARGV[i])
    table.insert(conflict, ARGV[i + 1])
  else
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
  end
end
if redis.call('HLEN', KEYS[1]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
end
return {conflict, redis.call('HGETALL', KEYS[1])}
`;

const REMOVE_LOCKS_SCRIPT = `
for i = 1, #ARGV, 2 do
  redis.call('HDEL', KEYS[1], ARGV[i])
end
return redis.call('HLEN', KEYS[1])
`;

const ADD_MESSAGE_SCRIPT = `
local length = redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return length
`;

const GETDEL_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;

// Force-save records use one hash field per scalar and payload.  Payload
// fields contain JSON encoded by Node.js and are never decoded by Redis Lua.
// The *Defined fields distinguish null from an omitted/undefined argument.
const FORCE_SAVE_FIELDS = [
  'time',
  'index',
  'baseUrl',
  'baseUrlDefined',
  'changeInfo',
  'changeInfoDefined',
  'convertInfo',
  'convertInfoDefined',
  'started',
  'ended'
];

const START_FORCE_SAVE_SCRIPT = `
local time = redis.call('HGET', KEYS[1], 'time')
if not time then
  return nil
end
if redis.call('HGET', KEYS[1], 'started') == '1' then
  return nil
end
redis.call('HSET', KEYS[1], 'started', '1', 'ended', '0')
redis.call('EXPIRE', KEYS[1], ARGV[1])
return redis.call('HMGET', KEYS[1], 'time', 'index', 'baseUrl', 'baseUrlDefined', 'changeInfo', 'changeInfoDefined', 'convertInfo', 'convertInfoDefined', 'started', 'ended')
`;

const SET_FORCE_SAVE_SCRIPT = `
local time = redis.call('HGET', KEYS[1], 'time')
if not time then
  return nil
end
local index = redis.call('HGET', KEYS[1], 'index')
if time ~= ARGV[1] or index ~= ARGV[2] then
  return nil
end
local started = redis.call('HGET', KEYS[1], 'started')
local ended = redis.call('HGET', KEYS[1], 'ended')
-- DocsCoServer uses null convertInfo for the command-path reset. Do not clear
-- an active conversion for that reset, but allow failed-conversion updates
-- that carry conversion information.
if started == '1' and ended == '0' and ARGV[3] == '0' and ARGV[4] == '0' and ARGV[5] == '1' and ARGV[6] == 'null' then
  return nil
end
redis.call('HSET', KEYS[1], 'started', ARGV[3], 'ended', ARGV[4])
if ARGV[5] == '1' then
  redis.call('HSET', KEYS[1], 'convertInfo', ARGV[6], 'convertInfoDefined', '1')
else
  redis.call('HSET', KEYS[1], 'convertInfo', '', 'convertInfoDefined', '0')
end
redis.call('EXPIRE', KEYS[1], ARGV[7])
return redis.call('HMGET', KEYS[1], 'time', 'index', 'baseUrl', 'baseUrlDefined', 'changeInfo', 'changeInfoDefined', 'convertInfo', 'convertInfoDefined', 'started', 'ended')
`;

const STORE_FORCE_SAVE_SCRIPT = `
-- This schema is intentionally new and has no compatibility path for the
-- pre-release single-field state representation.
redis.call('HSET', KEYS[1],
  'time', ARGV[1],
  'index', ARGV[2],
  'baseUrl', ARGV[3],
  'baseUrlDefined', ARGV[4],
  'changeInfo', ARGV[5],
  'changeInfoDefined', ARGV[6],
  'convertInfo', ARGV[7],
  'convertInfoDefined', ARGV[8],
  'started', '0',
  'ended', '0')
redis.call('EXPIRE', KEYS[1], ARGV[9])
return 1
`;

const ADD_MONTH_USER_SCRIPT = `
local ttl = redis.call('PTTL', KEYS[2])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
if ttl < 0 then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

const GET_UNIQUE_USERS_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
local active = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], '+inf', 'WITHSCORES')
local result = {}
for i = 1, #active, 2 do
  local info = redis.call('HGET', KEYS[2], active[i])
  if info then
    table.insert(result, active[i])
    table.insert(result, active[i + 1])
    table.insert(result, info)
  end
end
return result
`;

const ADD_UNIQUE_USER_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

const SET_CONNECTION_SAMPLE_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

const SET_SHARD_COUNT_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return tonumber(ARGV[2])
`;

const INCR_SHARD_COUNT_SCRIPT = `
local value = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
if value < 0 then
  value = 0
  redis.call('HSET', KEYS[1], ARGV[1], 0)
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return value
`;

const GET_SHARD_COUNT_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
  for _, shardId in ipairs(expired) do
    redis.call('HDEL', KEYS[1], shardId)
  end
end
local values = redis.call('HVALS', KEYS[1])
local result = 0
for _, value in ipairs(values) do
  result = result + tonumber(value)
end
return result
`;

const CLEAN_DOCUMENT_SCRIPT = `
-- Presence is shared by all replicas.  Expire stale entries first, then only
-- remove document state when no live replica remains; otherwise an exiting
-- replica could delete another replica's locks or in-flight state.
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
if redis.call('HLEN', KEYS[2]) > 0 then
  return {0, ''}
end
local version = redis.call('GET', KEYS[3]) or ''
redis.call('DEL', unpack(KEYS))
return {1, version}
`;

module.exports = {
  LOCK_SCRIPT,
  UNLOCK_SCRIPT,
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  REMOVE_DOCUMENT_INDEX_SCRIPT,
  POP_EXPIRED_SCRIPT,
  ACK_EXPIRED_SCRIPT,
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT,
  ADD_MESSAGE_SCRIPT,
  GETDEL_SCRIPT,
  FORCE_SAVE_FIELDS,
  START_FORCE_SAVE_SCRIPT,
  SET_FORCE_SAVE_SCRIPT,
  STORE_FORCE_SAVE_SCRIPT,
  ADD_MONTH_USER_SCRIPT,
  ADD_UNIQUE_USER_SCRIPT,
  GET_UNIQUE_USERS_SCRIPT,
  SET_CONNECTION_SAMPLE_SCRIPT,
  SET_SHARD_COUNT_SCRIPT,
  INCR_SHARD_COUNT_SCRIPT,
  GET_SHARD_COUNT_SCRIPT,
  CLEAN_DOCUMENT_SCRIPT
};
