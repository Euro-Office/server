/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {DECODE_JSON_OBJECT, REDIS_TIME_MILLIS} = require('./helpers');

// KEYS[4] is the document's closed marker: a user joining starts a new session.
const ADD_PRESENCE_SCRIPT = `
${REDIS_TIME_MILLIS}
redis.call('DEL', KEYS[4])
local expireAt = redisTimeMillis() + tonumber(ARGV[3]) * 1000
redis.call('ZADD', KEYS[1], expireAt, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], tostring(expireAt), 'EX', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return {1, tostring(expireAt)}
`;

const UPDATE_PRESENCE_SCRIPT = `
${REDIS_TIME_MILLIS}
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  if ARGV[3] == '' then
    return 0
  end
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
  -- A re-created entry is a user (re)joining, as in ADD_PRESENCE.
  redis.call('DEL', KEYS[4])
end
local expireAt = redisTimeMillis() + tonumber(ARGV[2]) * 1000
redis.call('ZADD', KEYS[1], expireAt, ARGV[1])
redis.call('SET', KEYS[3], tostring(expireAt), 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return {1, tostring(expireAt)}
`;

const GET_PRESENCE_SCRIPT = `
${REDIS_TIME_MILLIS}
local now = redisTimeMillis()
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
local values = redis.call('HVALS', KEYS[2])
local remaining = redis.call('ZREVRANGE', KEYS[1], '0', '0', 'WITHSCORES')
local version = redis.call('GET', KEYS[3]) or ''
local score = ''
if #values > 0 then
  score = remaining[2] or version
  if score == '' then
    local ttl = redis.call('PTTL', KEYS[2])
    if ttl > 0 then
      score = tostring(now + ttl)
    end
  end
end
return {values, score, version}
`;

const REMOVE_PRESENCE_SCRIPT = `
${REDIS_TIME_MILLIS}
${DECODE_JSON_OBJECT}
local now = redisTimeMillis()
local current = redis.call('HGET', KEYS[2], ARGV[1])
local removed = 0
if current then
  local matches = ARGV[2] == ''
  if not matches then
    local decoded = decodeJsonObject(current)
    matches = decoded ~= nil and decoded.connectionId == ARGV[2]
  end
  if matches then
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('HDEL', KEYS[2], ARGV[1])
    removed = 1
  end
else
  -- A partially lost presence entry must not leave a stale set member behind.
  redis.call('ZREM', KEYS[1], ARGV[1])
end
local remaining = redis.call('ZREVRANGE', KEYS[1], '0', '0', 'WITHSCORES')
local version = redis.call('GET', KEYS[3]) or ''
local count = redis.call('HLEN', KEYS[2])
local score = ''
if count > 0 then
  score = remaining[2] or version
  if score == '' then
    local ttl = redis.call('PTTL', KEYS[2])
    if ttl > 0 then
      score = tostring(now + ttl)
    end
  end
end
return {removed, count, version, score}
`;

const PREPARE_PRESENCE_REMOVAL_SCRIPT = `
${REDIS_TIME_MILLIS}
local now = redisTimeMillis()
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
if redis.call('HLEN', KEYS[2]) > 0 then
  local remaining = redis.call('ZREVRANGE', KEYS[1], '0', '0', 'WITHSCORES')
  local version = redis.call('GET', KEYS[3]) or ''
  local score = remaining[2] or version
  if score == '' then
    local ttl = redis.call('PTTL', KEYS[2])
    if ttl > 0 then
      score = tostring(now + ttl)
    end
  end
  return {0, score, version}
end
local version = redis.call('GET', KEYS[3]) or ''
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {1, version}
`;

// A process that dies never removes its users' presence entries or locks (only
// closeDocument does). This drops the expired presence entries, then the locks
// whose owner is in no presence entry left and not in ARGV (the users connected
// to the calling replica). Nothing is released while no presence entry is left
// (the whole document is GC's) or while an entry cannot be read. A lock whose
// owner cannot be read is kept.
// KEYS: presence set, presence hash, locks. Returns {expired users, released
// lockId/lock pairs, remaining presence entries}.
const RELEASE_ABSENT_USERS_SCRIPT = `
${REDIS_TIME_MILLIS}
${DECODE_JSON_OBJECT}
local now = redisTimeMillis()
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
local released = {}
local values = redis.call('HVALS', KEYS[2])
if #values == 0 then
  return {expired, released, values}
end
local present = {}
for _, userId in ipairs(ARGV) do
  present[userId] = true
end
for _, value in ipairs(values) do
  local entry = decodeJsonObject(value)
  if entry == nil or type(entry.id) ~= 'string' then
    return {expired, released, values}
  end
  present[entry.id] = true
end
local locks = redis.call('HGETALL', KEYS[3])
for i = 1, #locks, 2 do
  local lock = decodeJsonObject(locks[i + 1])
  if lock ~= nil and type(lock.user) == 'string' and not present[lock.user] then
    redis.call('HDEL', KEYS[3], locks[i])
    table.insert(released, locks[i])
    table.insert(released, locks[i + 1])
  end
end
return {expired, released, values}
`;

const SYNC_DOCUMENT_PRESENCE_INDEX_SCRIPT = `
${REDIS_TIME_MILLIS}
local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
local expected = ARGV[2]
local desired = ARGV[3]
if desired ~= '' then
  if not current then
    return redis.call('ZADD', KEYS[1], desired, ARGV[1])
  end
  if expected ~= '' and tonumber(current) <= tonumber(expected) then
    return redis.call('ZADD', KEYS[1], desired, ARGV[1])
  end
  if expected == '' and tonumber(current) <= tonumber(desired) then
    return redis.call('ZADD', KEYS[1], desired, ARGV[1])
  end
  return 0
end
if not current then
  return 0
end
-- A removal follows a script that saw no presence left. expected is the version
-- marker, the latest expiry written for the document; the entry can be lower
-- (a leaving user moves it down to the remaining users' latest expiry), so it
-- is removed when it is not newer. A replica that adds presence afterwards
-- writes a later expiry, which this does not remove.
if expected ~= '' and tonumber(current) <= tonumber(expected) then
  return redis.call('ZREM', KEYS[1], ARGV[1])
end
if expected == '' and tonumber(current) <= redisTimeMillis() then
  return redis.call('ZREM', KEYS[1], ARGV[1])
end
return 0
`;

module.exports = {
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  RELEASE_ABSENT_USERS_SCRIPT,
  SYNC_DOCUMENT_PRESENCE_INDEX_SCRIPT
};
