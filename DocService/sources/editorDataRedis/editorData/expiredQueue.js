/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const redisConnection = require('../redisConnection');
const {
  EDITOR_INDEX_SHARD_COUNT,
  EDITOR_INDEX_QUEUES,
  documentMember,
  decodeDocumentMember
} = require('../redisKeys');
const {POP_EXPIRED_BATCH_SIZE} = require('../editorDataSettings');
const {POP_EXPIRED_SCRIPT, ACK_EXPIRED_SCRIPT} = require('../scripts');
const {strictMax} = require('../redisValueCodec');

const expiredClaimIds = new WeakMap();

function addExpiredBatchMetadata(batch, hasMore, hasShardFailure = false, shardFailures = []) {
  // Keep the public return value an array for existing callers, while carrying
  // a continuation signal that survives a per-shard pop being flattened.
  Object.defineProperty(batch, 'hasMore', {value: hasMore, enumerable: false});
  Object.defineProperty(batch, 'hasShardFailure', {value: hasShardFailure, enumerable: false});
  Object.defineProperty(batch, 'shardFailures', {value: shardFailures, enumerable: false});
  return batch;
}

module.exports = function attachExpiredQueue(EditorData) {
  EditorData.prototype._nextExpiredClaim = function () {
    this.expiredClaimSequence += 1;
    return `${this.expiredClaimOwner}:${this.expiredClaimSequence}`;
  };

  EditorData.prototype._popExpired = async function (indexKey, leaseKey, claimsKey, now, useRedisTime) {
    const claimId = this._nextExpiredClaim();
    const args = useRedisTime
      ? ['', String(this.expiredClaimLeaseMs), String(POP_EXPIRED_BATCH_SIZE), claimId, 'redis-time']
      : [strictMax(now), String(Date.now() + this.expiredClaimLeaseMs), String(POP_EXPIRED_BATCH_SIZE), claimId, ''];
    const values = await this._eval(POP_EXPIRED_SCRIPT, [indexKey, leaseKey, claimsKey], args);
    const result = [];
    for (const value of values || []) {
      const item = decodeDocumentMember(value);
      if (item) {
        expiredClaimIds.set(item, claimId);
        result.push(item);
      }
    }
    return addExpiredBatchMetadata(result, (values || []).length >= POP_EXPIRED_BATCH_SIZE);
  };

  EditorData.prototype._ackExpired = async function (leaseKey, claimsKey, item) {
    const claimId = item && expiredClaimIds.get(item);
    if (!claimId) {
      return false;
    }
    const member = documentMember({tenant: item[0]}, item[1]);
    const result = await this._eval(ACK_EXPIRED_SCRIPT, [leaseKey, claimsKey], [claimId, member]);
    return Number(result) === 1;
  };

  EditorData.prototype._ackDocumentPresenceExpired = function (item) {
    return this._ackExpiredQueue('documents', item);
  };

  EditorData.prototype._ackExpiredQueue = function (queueName, item) {
    const queue = EDITOR_INDEX_QUEUES[queueName];
    const keys = this._indexKeysForItem(item);
    return queue && keys ? this._ackExpired(keys[queue.lease], keys[queue.claims], item) : false;
  };

  EditorData.prototype._popExpiredAcrossShards = async function (queueName, now) {
    const queue = EDITOR_INDEX_QUEUES[queueName];
    if (!queue) {
      throw new Error(`Unknown expired editor-data queue: ${queueName}`);
    }
    const results = await Promise.allSettled(
      Array.from({length: EDITOR_INDEX_SHARD_COUNT}, (_, shard) => {
        const keys = this._indexKeysForShard(shard);
        return this._popExpired(keys[queue.index], keys[queue.lease], keys[queue.claims], now, queueName === 'documents');
      })
    );
    const batches = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const shardFailures = results.flatMap((result, shard) => {
      if (result.status !== 'rejected') {
        return [];
      }
      const reason = result.reason;
      redisConnection.log('error', 'expired %s queue pop failed on shard %d: %s', queueName, shard, redisConnection.errorDetails(reason));
      return [
        {
          shard,
          message: reason instanceof Error ? reason.message : String(reason),
          code: reason && reason.code
        }
      ];
    });
    const hasShardFailure = shardFailures.length > 0;
    return addExpiredBatchMetadata(batches.flat(), hasShardFailure || batches.some(batch => batch.hasMore === true), hasShardFailure, shardFailures);
  };

  EditorData.prototype.getDocumentPresenceExpired = function (_now) {
    return this._popExpiredAcrossShards('documents');
  };

  EditorData.prototype.addForceSaveTimerNX = async function (ctx, docId, expireAt) {
    await this._command(['ZADD', this._indexKeys(ctx, docId).forceSaveTimer, 'NX', String(expireAt), documentMember(ctx, docId)]);
  };

  EditorData.prototype._ackForceSaveTimer = function (item) {
    return this._ackExpiredQueue('forceSaveTimer', item);
  };

  EditorData.prototype.getForceSaveTimer = function (now) {
    return this._popExpiredAcrossShards('forceSaveTimer', now);
  };
};
