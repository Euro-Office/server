/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const {toRedisString, losslessText} = require('./redisValueCodec');
const {hasNodeCluster} = require('./redisConfig/clusterOptions');
const {log} = require('./redisConnection/helpers');

const cfgRedisPrefix = config.get('services.CoAuthoring.redis').get('prefix');

// Every key is "<prefix>{<hash tag>}...". Redis Cluster hashes the first {...}
// of a key with something between the braces, or the whole key when that is
// empty. A "{}" in the prefix therefore hashes every key whole: every
// multi-key script fails with CROSSSLOT (and node-redis computes another slot
// than Redis). A non-empty tag such as "{ds}" works but puts every key on one
// master. Braces mean nothing outside a Cluster.
function checkPrefixForCluster(prefix) {
  const open = prefix.indexOf('{');
  const close = open === -1 ? -1 : prefix.indexOf('}', open + 1);
  if (close === open + 1) {
    throw new Error(`services.CoAuthoring.redis.prefix ${JSON.stringify(prefix)} contains an empty "{}" hash tag, which breaks Redis Cluster`);
  }
  if (close !== -1) {
    log('warn', 'services.CoAuthoring.redis.prefix %j contains a hash tag: every key is stored on one Redis Cluster master', prefix);
  }
}
if (hasNodeCluster()) {
  checkPrefixForCluster(String(cfgRedisPrefix));
}
// Cross-document indexes are spread across fixed hash tags so expiration and
// force-save traffic does not concentrate on one Redis Cluster master. Keep
// this stable: changing it changes the key schema and requires an explicit
// migration of existing index entries.
const EDITOR_INDEX_SHARD_COUNT = 16;
const EDITOR_INDEX_QUEUES = Object.freeze({
  documents: Object.freeze({index: 'documents', lease: 'documentsExpiredLease', claims: 'documentsExpiredClaims'}),
  forceSaveTimer: Object.freeze({index: 'forceSaveTimer', lease: 'forceSaveExpiredLease', claims: 'forceSaveExpiredClaims'})
});

// Redis stores keys as UTF-8, which turns a lone UTF-16 surrogate into U+FFFD,
// so two ids that differ only there would share keys. Such an id gets a
// separate, lossless form; "~" never occurs in base64url, so the two forms
// cannot collide and every other id keeps its key.
const LONE_SURROGATE = /\p{Cs}/u;
function encodePart(value) {
  const text = String(value);
  if (LONE_SURROGATE.test(text)) {
    return `~${Buffer.from(losslessText(text), 'utf8').toString('base64url')}`;
  }
  return Buffer.from(text, 'utf8').toString('base64url');
}

function tenantName(ctx) {
  return ctx && ctx.tenant !== undefined && ctx.tenant !== null ? String(ctx.tenant) : '';
}

function documentMember(ctx, docId) {
  return JSON.stringify([tenantName(ctx), String(docId)]);
}

function editorIndexShard(ctx, docId) {
  const input = Buffer.from(documentMember(ctx, docId), 'utf8');
  let hash = 2166136261;
  for (const byte of input) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return hash % EDITOR_INDEX_SHARD_COUNT;
}

function editorIndexTagForShard(shard) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= EDITOR_INDEX_SHARD_COUNT) {
    throw new Error(`Invalid editor index shard: ${shard}`);
  }
  return `{editor:index:${shard}}`;
}

function editorIndexTag(ctx, docId) {
  return editorIndexTagForShard(editorIndexShard(ctx, docId));
}

function editorIndexKeysForShard(shard) {
  const base = `${cfgRedisPrefix}${editorIndexTagForShard(shard)}`;
  return {
    documents: `${base}:documents`,
    documentsExpiredLease: `${base}:documents:expired:lease`,
    documentsExpiredClaims: `${base}:documents:expired:claims`,
    forceSaveTimer: `${base}:forcesavetimer`,
    forceSaveExpiredLease: `${base}:forcesavetimer:expired:lease`,
    forceSaveExpiredClaims: `${base}:forcesavetimer:expired:claims`
  };
}

function editorIndexKeys(ctx, docId) {
  return editorIndexKeysForShard(editorIndexShard(ctx, docId));
}

function forceSaveTimerCleanupKey(ctx, docId) {
  return `${editorIndexKeys(ctx, docId).forceSaveTimer}:cleanup:${encodePart(documentMember(ctx, docId))}`;
}

function editorIndexKeysForItem(item) {
  if (!Array.isArray(item) || item.length !== 2) {
    return null;
  }
  return editorIndexKeys({tenant: item[0]}, item[1]);
}

function decodeDocumentMember(value) {
  try {
    const parsed = JSON.parse(toRedisString(value));
    return Array.isArray(parsed) && parsed.length === 2 ? parsed : null;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  checkPrefixForCluster,
  cfgRedisPrefix,
  EDITOR_INDEX_SHARD_COUNT,
  EDITOR_INDEX_QUEUES,
  encodePart,
  tenantName,
  documentMember,
  editorIndexShard,
  editorIndexTag,
  editorIndexTagForShard,
  editorIndexKeys,
  forceSaveTimerCleanupKey,
  editorIndexKeysForShard,
  editorIndexKeysForItem,
  decodeDocumentMember
};
