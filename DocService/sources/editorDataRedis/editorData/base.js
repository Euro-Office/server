/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {randomUUID} = require('crypto');

const {EditorCommon} = require('../editorCommon');
const {connectionGroups} = require('../redisConnectionManager');
const {editorIndexKeys, editorIndexKeysForItem, editorIndexKeysForShard} = require('../redisKeys');
const {POP_EXPIRED_LEASE_MS} = require('../editorDataSettings');

function EditorData() {
  EditorCommon.call(this, undefined, connectionGroups.editorData);
  this.expiredClaimOwner = randomUUID();
  this.expiredClaimSequence = 0;
  // Tests can shorten this internal lease; production keeps enough time for a
  // normal GC pass while still recovering a lost response on a later pass.
  this.expiredClaimLeaseMs = POP_EXPIRED_LEASE_MS;
}

EditorData.prototype = Object.create(EditorCommon.prototype);
EditorData.prototype.constructor = EditorData;

EditorData.prototype._indexKeysForShard = editorIndexKeysForShard;
EditorData.prototype._indexKeys = editorIndexKeys;
EditorData.prototype._indexKeysForItem = editorIndexKeysForItem;

EditorData.prototype._docKeys = function (ctx, docId) {
  const base = this._docBase(ctx, docId);
  return {
    presenceSet: `${base}presence:set`,
    presenceHash: `${base}presence:hash`,
    presenceVersion: `${base}presence:version`,
    saveLock: `${base}savelock`,
    authLock: `${base}lockdocument`,
    locks: `${base}locks`,
    messages: `${base}message`,
    saved: `${base}saved`,
    // Keep the claim under the document hash tag so the claim/read/delete
    // script remains atomic on Redis Cluster as well as standalone Redis.
    savedClaim: `${base}saved:claim`,
    forceSave: `${base}forcesave`
  };
};

module.exports = EditorData;
