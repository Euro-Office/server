/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {DECODE_JSON_OBJECT} = require('./helpers');

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
${DECODE_JSON_OBJECT}
-- ARGV holds lockId/lock pairs as the caller read or wrote them. A lock that
-- another user holds by now is not removed: callers read the locks first and
-- remove them in a separate call, and another replica can release and grant
-- the same block in between.
for i = 1, #ARGV, 2 do
  local current = redis.call('HGET', KEYS[1], ARGV[i])
  if current then
    local stored = decodeJsonObject(current)
    local expected = decodeJsonObject(ARGV[i + 1])
    local otherOwner = stored ~= nil and expected ~= nil and stored.user ~= nil and expected.user ~= nil and stored.user ~= expected.user
    if not otherOwner then
      redis.call('HDEL', KEYS[1], ARGV[i])
    end
  end
end
return redis.call('HLEN', KEYS[1])
`;

module.exports = {
  LOCK_SCRIPT,
  UNLOCK_SCRIPT,
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT
};
