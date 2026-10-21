/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {REDIS_TIME_MILLIS} = require('./helpers');

const CLEAN_DOCUMENT_SCRIPT = `
${REDIS_TIME_MILLIS}
-- Presence is shared by all replicas.  Expire stale entries first, then only
-- remove document state when no live replica remains; otherwise an exiting
-- replica could delete another replica's locks or in-flight state. During
-- terminal cleanup, an unowned saved claim is recovered as abandoned. The
-- operation that owns a claim passes its id in ARGV[2], so its claim remains
-- available for acknowledgement after cleanup. Claim-less viewer cleanup sets
-- ARGV[3] so an active callback claim remains leased while the other state is
-- removed; its lease handles abandoned-claim recovery.
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
local claimOwner = redis.call('HGET', KEYS[9], 'id')
if claimOwner and ARGV[2] ~= '' and claimOwner ~= ARGV[2] then
  -- An operation id was supplied, but another operation owns the claim. A
  -- stale worker must not clean up the document or the newer claim.
  return {2, version}
end
if claimOwner and ARGV[2] == '' and ARGV[3] == '1' then
  -- This is claim-less final-viewer cleanup. Presence is gone, but a callback
  -- may still be using the claim, so remove the document state while leaving
  -- the claim leased for acknowledgement or abandoned-claim recovery.
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[10])
  return {3, version}
end
if claimOwner and ARGV[2] ~= '' and claimOwner == ARGV[2] then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[10])
else
  -- Ordinary claim-less terminal cleanup treats the claim as abandoned. The
  -- saved claim is deleted with the rest of the document state in this path.
  redis.call('DEL', unpack(KEYS))
end
return {1, version}
`;

module.exports = {CLEAN_DOCUMENT_SCRIPT};
