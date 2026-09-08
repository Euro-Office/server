'use strict';

// Shared key/member encoding for every Redis-backed editorData store - one
// helper, not a per-phase reimplementation, so a fix to the encoding scheme
// only has to happen once instead of drifting across independent copies.
// No Redis I/O here - pure string helpers, independently unit-testable.

function buildKey(prefix, tenant, docId) {
  return `${prefix}${encodeURIComponent(tenant)}:${encodeURIComponent(docId)}`;
}

// For values that need to round-trip back into a real (tenant, docId) pair
// after being read back off a Redis structure (sorted-set members, mainly) -
// same encoding as buildKey, kept separate since it has no prefix and a
// paired decode function.
function encodePair(tenant, docId) {
  return `${encodeURIComponent(tenant)}:${encodeURIComponent(docId)}`;
}
function decodePair(member) {
  const idx = member.indexOf(':');
  return [decodeURIComponent(member.slice(0, idx)), decodeURIComponent(member.slice(idx + 1))];
}

// Deterministic, dependency-free string hash - only needs to distribute
// tenants roughly evenly across shards, not to be cryptographically sound.
function shardIndex(tenant, numShards) {
  let hash = 0;
  for (let i = 0; i < tenant.length; i++) {
    hash = (hash * 31 + tenant.charCodeAt(i)) >>> 0;
  }
  return hash % numShards;
}

module.exports = {buildKey, encodePair, decodePair, shardIndex};
