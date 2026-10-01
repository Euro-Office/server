'use strict';

// encodeURIComponent so a ':' inside tenant or docId can't be mistaken for
// the separator. The braces are a Redis Cluster hash tag: only what is
// inside them is hashed, so one document's keys share a slot and its
// two-key scripts and DELs are not CROSSSLOT.
function buildKey(prefix, tenant, docId) {
  return `${prefix}{${encodeURIComponent(tenant)}:${encodeURIComponent(docId)}}`;
}

function encodePair(tenant, docId) {
  return `${encodeURIComponent(tenant)}:${encodeURIComponent(docId)}`;
}
function decodePair(member) {
  const idx = member.indexOf(':');
  return [decodeURIComponent(member.slice(0, idx)), decodeURIComponent(member.slice(idx + 1))];
}

// Must stay deterministic per (tenant, docId): track() and untrack() have to
// agree on the shard. Keyed on both, not tenant alone - a single-tenant
// deployment would otherwise put every document in one shard.
function shardIndex(tenant, docId, numShards) {
  let hash = 0;
  for (let i = 0; i < tenant.length; i++) {
    hash = (hash * 31 + tenant.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < docId.length; i++) {
    hash = (hash * 31 + docId.charCodeAt(i)) >>> 0;
  }
  return hash % numShards;
}

module.exports = {buildKey, encodePair, decodePair, shardIndex};
