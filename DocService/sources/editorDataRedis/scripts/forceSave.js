/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

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

module.exports = {
  FORCE_SAVE_FIELDS,
  START_FORCE_SAVE_SCRIPT,
  SET_FORCE_SAVE_SCRIPT,
  STORE_FORCE_SAVE_SCRIPT
};
