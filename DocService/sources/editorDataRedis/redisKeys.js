/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const {toRedisString} = require('./redisValueCodec');

const cfgRedisPrefix = config.get('services.CoAuthoring.redis').get('prefix');
// Cross-document indexes are spread across fixed hash tags so expiration and
// force-save traffic does not concentrate on one Redis Cluster master. Keep
// this stable: changing it changes the key schema and requires an explicit
// migration of existing index entries.
const EDITOR_INDEX_SHARD_COUNT = 16;

function encodePart(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
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
  cfgRedisPrefix,
  EDITOR_INDEX_SHARD_COUNT,
  encodePart,
  tenantName,
  documentMember,
  editorIndexShard,
  editorIndexTag,
  editorIndexTagForShard,
  editorIndexKeys,
  editorIndexKeysForShard,
  editorIndexKeysForItem,
  decodeDocumentMember
};
