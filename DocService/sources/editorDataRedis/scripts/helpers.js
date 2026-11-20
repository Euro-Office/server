/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const REDIS_TIME_MILLIS = `
local function redisTimeMillis()
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
`;

// Presence entries and locks are JSON.stringify output. JSON.stringify writes a
// lone UTF-16 surrogate (for example a user name cut inside an emoji) as a
// \\udXXX escape, which Redis' cjson rejects. Decoding retries with every
// surrogate escape replaced; the fields read (connectionId, view,
// isCloseCoAuthoring, user) do not change. Returns nil for anything that is not
// a JSON object.
const DECODE_JSON_OBJECT = `
local function decodeJsonObject(value)
  local ok, decoded = pcall(cjson.decode, value)
  if not ok then
    ok, decoded = pcall(cjson.decode, (string.gsub(value, '\\\\u[dD][89a-fA-F]%x%x', '\\\\ufffd')))
  end
  if ok and type(decoded) == 'table' then
    return decoded
  end
  return nil
end
`;

module.exports = {DECODE_JSON_OBJECT, REDIS_TIME_MILLIS};
