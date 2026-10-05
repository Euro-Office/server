/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

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

module.exports = {
  ADD_MONTH_USER_SCRIPT,
  ADD_UNIQUE_USER_SCRIPT,
  GET_UNIQUE_USERS_SCRIPT,
  SET_CONNECTION_SAMPLE_SCRIPT,
  SET_SHARD_COUNT_SCRIPT,
  INCR_SHARD_COUNT_SCRIPT,
  GET_SHARD_COUNT_SCRIPT
};
