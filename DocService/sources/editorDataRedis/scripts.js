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
local values = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if #values > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
end
return values
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

const START_FORCE_SAVE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], 'state')
if not raw then
  return nil
end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.started then
  return nil
end
value.started = true
value.ended = false
value.convertInfo = nil
local updated = cjson.encode(value)
redis.call('HSET', KEYS[1], 'state', updated)
redis.call('EXPIRE', KEYS[1], ARGV[1])
return updated
`;

const SET_FORCE_SAVE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], 'state')
if not raw then
  return nil
end
local ok, value = pcall(cjson.decode, raw)
if not ok then
  return nil
end
local expectedTime = cjson.decode(ARGV[1])
local expectedIndex = cjson.decode(ARGV[2])
if value.time ~= expectedTime or value.index ~= expectedIndex then
  return nil
end
value.started = ARGV[3] == '1'
value.ended = ARGV[4] == '1'
if ARGV[5] == '1' then
  value.convertInfo = cjson.decode(ARGV[6])
else
  value.convertInfo = nil
end
local updated = cjson.encode(value)
redis.call('HSET', KEYS[1], 'state', updated)
redis.call('EXPIRE', KEYS[1], ARGV[7])
return updated
`;

const STORE_FORCE_SAVE_SCRIPT = `
redis.call('HSET', KEYS[1], 'state', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

const ADD_MONTH_USER_SCRIPT = `
local ttl = redis.call('PTTL', KEYS[2])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
if ttl < 0 then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
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
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT,
  ADD_MESSAGE_SCRIPT,
  GETDEL_SCRIPT,
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
