/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {DECODE_JSON_OBJECT, REDIS_TIME_MILLIS} = require('./helpers');

const CLEAN_DOCUMENT_SCRIPT = `
${REDIS_TIME_MILLIS}
${DECODE_JSON_OBJECT}
-- Presence is shared by all replicas.  Expire stale entries first, then only
-- remove document state when no live editor remains on any replica; otherwise
-- an exiting replica could delete another replica's locks or in-flight state.
-- The third result element is '1' when viewers remain (see below). A cleanup
-- that ran sets the closed marker KEYS[11] for ARGV[4] seconds. During
-- terminal cleanup, an unowned saved claim is recovered as abandoned. The
-- operation that owns a claim passes its id in ARGV[2], so its claim remains
-- available for acknowledgement after cleanup. Claim-less viewer cleanup sets
-- ARGV[3] so the in-flight final save's state -- the unclaimed saved status, the
-- saved claim and the force-save entry -- is kept while the other state is
-- removed; the claim lease handles abandoned-claim recovery.
--
-- Only an editor's presence blocks cleanup. Viewers (and editors whose
-- co-authoring was closed, which DocsCoServer counts as viewers) never block
-- it, as with the in-memory backend: otherwise a viewer left open makes the
-- final save's cleanup fail until its retry budget is used up, and the changes,
-- the forgotten file and the WOPI lock stay behind. Their presence entries
-- (KEYS[1-3]) are kept, so the documents index and their own exit still work.
-- An entry that cannot be decoded counts as an editor.
local now = redisTimeMillis()
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #expired > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  for _, userId in ipairs(expired) do
    redis.call('HDEL', KEYS[2], userId)
  end
end
local function onlyViewersRemain()
  for _, value in ipairs(redis.call('HVALS', KEYS[2])) do
    local decoded = decodeJsonObject(value)
    if not decoded or (decoded.view ~= true and decoded.isCloseCoAuthoring ~= true) then
      return false
    end
  end
  return true
end
local viewersRemain = false
if redis.call('HLEN', KEYS[2]) > 0 then
  if not onlyViewersRemain() then
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
  viewersRemain = true
end
-- Deletes the given KEYS indexes, skipping the presence keys (1-3) while
-- viewers remain.
local function deleteKeys(indexes)
  local names = {}
  for _, index in ipairs(indexes) do
    if not (viewersRemain and index <= 3) then
      names[#names + 1] = KEYS[index]
    end
  end
  if #names > 0 then
    redis.call('DEL', unpack(names))
  end
end
local viewersFlag = viewersRemain and '1' or ''
local function markClosed()
  if ARGV[4] ~= nil and ARGV[4] ~= '' then
    redis.call('SET', KEYS[11], '1', 'EX', ARGV[4])
  end
end
local version = redis.call('GET', KEYS[3]) or ''
local claimOwner = redis.call('HGET', KEYS[9], 'id')
if claimOwner and ARGV[2] ~= '' and claimOwner ~= ARGV[2] then
  -- An operation id was supplied, but another operation owns the claim. A
  -- stale worker must not clean up the document or the newer claim.
  return {2, version}
end
if ARGV[2] == '' and ARGV[3] == '1' then
  -- Final-viewer cleanup that may run while a final save for the last editor
  -- is still in flight. Remove only the presence, lock and message state and
  -- keep the unclaimed saved status (KEYS[8]), the saved claim (KEYS[9]) and
  -- the force-save entry (KEYS[10]) so the in-flight save can still consume
  -- them. This holds even when no claim exists yet: a corrupted save writes the
  -- saved status before any claim, and deleting it here would make getdelSaved
  -- return null, so the corrupted save would be reported as a success and its
  -- changes deleted (mirrors editorDataMemory's preserveSavedClaim).
  deleteKeys({1, 2, 3, 4, 5, 6, 7})
  markClosed()
  return {3, version, viewersFlag}
end
if claimOwner and ARGV[2] ~= '' and claimOwner == ARGV[2] then
  deleteKeys({1, 2, 3, 4, 5, 6, 7, 8, 10})
else
  -- Ordinary claim-less terminal cleanup treats the claim as abandoned. The
  -- saved claim is deleted with the rest of the document state in this path.
  deleteKeys({1, 2, 3, 4, 5, 6, 7, 8, 9, 10})
end
markClosed()
return {1, version, viewersFlag}
`;

module.exports = {CLEAN_DOCUMENT_SCRIPT};
