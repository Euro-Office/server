/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  RELEASE_ABSENT_USERS_SCRIPT,
  SYNC_DOCUMENT_PRESENCE_INDEX_SCRIPT
} = require('../scripts');
const redisConnection = require('../redisConnection');
const {documentMember} = require('../redisKeys');
const {cfgExpPresence} = require('../editorDataSettings');
const {refreshedTtlSeconds, toRedisString, losslessText, fromLosslessText, decodeHash} = require('../redisValueCodec');

module.exports = function attachPresence(EditorData) {
  EditorData.prototype._syncPresenceIndex = function (ctx, docId, expected, desired) {
    return this._eval(
      SYNC_DOCUMENT_PRESENCE_INDEX_SCRIPT,
      [this._indexKeys(ctx, docId).documents],
      [documentMember(ctx, docId), expected || '', desired || '']
    );
  };

  // The presence itself is already written when the index update runs, and
  // the index is in another Cluster slot. Failing the call then would fail a
  // join (or a whole presence refresh pass in DocsCoServer) for presence that
  // exists; the next refresh writes the index again.
  EditorData.prototype._syncPresenceIndexAfterWrite = async function (ctx, docId, expireAt) {
    try {
      await this._syncPresenceIndex(ctx, docId, expireAt, expireAt);
    } catch (error) {
      redisConnection.log('warn', 'presence index update after a presence write failed: %s', redisConnection.errorDetails(error));
    }
  };

  EditorData.prototype.addPresence = async function (ctx, docId, userId, userInfo) {
    const keys = this._docKeys(ctx, docId);
    const ttl = refreshedTtlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
    const result = await this._eval(
      ADD_PRESENCE_SCRIPT,
      [keys.presenceSet, keys.presenceHash, keys.presenceVersion, keys.closed],
      [losslessText(userId), String(userInfo), String(ttl)]
    );
    const expireAt = toRedisString(result?.[1] || '');
    // The document index is intentionally updated separately: document presence
    // keys are hash-tagged per document, while this sharded index has its own
    // hash tag. Redis Cluster cannot execute both key groups in one Lua script.
    // Only move the index forward when concurrent replicas finish out of order.
    await this._syncPresenceIndexAfterWrite(ctx, docId, String(expireAt));
  };

  EditorData.prototype.updatePresence = async function (ctx, docId, userId, ...presenceArgs) {
    const userInfo = presenceArgs[0];
    const keys = this._docKeys(ctx, docId);
    const ttl = refreshedTtlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
    const updated = await this._eval(
      UPDATE_PRESENCE_SCRIPT,
      [keys.presenceSet, keys.presenceHash, keys.presenceVersion, keys.closed],
      [losslessText(userId), String(ttl), userInfo === undefined ? '' : String(userInfo)]
    );
    if (Number(updated?.[0]) === 1) {
      const expireAt = toRedisString(updated[1] || '');
      await this._syncPresenceIndexAfterWrite(ctx, docId, String(expireAt));
    }
  };

  EditorData.prototype.removePresence = async function (ctx, docId, userId, ...presenceArgs) {
    const connectionId = presenceArgs[0];
    const keys = this._docKeys(ctx, docId);
    const result = await this._eval(
      REMOVE_PRESENCE_SCRIPT,
      [keys.presenceSet, keys.presenceHash, keys.presenceVersion],
      [losslessText(userId), connectionId === undefined ? '' : String(connectionId)]
    );
    await this._syncPresenceIndex(ctx, docId, toRedisString(result?.[2] || ''), toRedisString(result?.[3] || ''));
  };

  EditorData.prototype.getPresence = async function (ctx, docId, _connections) {
    const keys = this._docKeys(ctx, docId);
    const result = await this._eval(GET_PRESENCE_SCRIPT, [keys.presenceSet, keys.presenceHash, keys.presenceVersion], []);
    const values = Array.isArray(result?.[0]) ? result[0] : result || [];
    const score = toRedisString(result?.[1] || '');
    // A read only moves the documents index forward. It never removes the
    // entry: presence that expired without a clean exit (a replica that died)
    // is what GC looks for, and a read in between would hide the document from
    // it. The index is in another Cluster slot; the presence read itself has
    // already succeeded, so a failing index update does not fail the read.
    if (score !== '') {
      try {
        await this._syncPresenceIndex(ctx, docId, toRedisString(result?.[2] || ''), score);
      } catch (error) {
        redisConnection.log('warn', 'presence index update after a presence read failed: %s', redisConnection.errorDetails(error));
      }
    }
    return values.map(toRedisString);
  };

  // Drops expired presence entries and releases the locks of users who are no
  // longer present (their process died, see RELEASE_ABSENT_USERS_SCRIPT).
  // connectedUserIds are the users connected to this process: they keep their
  // locks whatever their presence entry says. The documents index is not
  // touched: the remaining entries keep the document's latest expiry.
  EditorData.prototype._releaseAbsentUsers = async function (ctx, docId, connectedUserIds = []) {
    const keys = this._docKeys(ctx, docId);
    const result = await this._eval(
      RELEASE_ABSENT_USERS_SCRIPT,
      [keys.presenceSet, keys.presenceHash, keys.locks],
      connectedUserIds.map(userId => String(userId))
    );
    return {
      expiredUsers: (result?.[0] || []).map(fromLosslessText),
      locks: Object.values(decodeHash(result?.[1])).filter(lock => lock && typeof lock === 'object'),
      presence: (result?.[2] || []).map(toRedisString)
    };
  };

  EditorData.prototype.removePresenceDocument = async function (ctx, docId) {
    const keys = this._docKeys(ctx, docId);
    const result = await this._eval(PREPARE_PRESENCE_REMOVAL_SCRIPT, [keys.presenceSet, keys.presenceHash, keys.presenceVersion], []);
    if (result && Number(result[0]) === 1) {
      await this._syncPresenceIndex(ctx, docId, toRedisString(result[1] || ''), '');
    } else if (result) {
      await this._syncPresenceIndex(ctx, docId, toRedisString(result[2] || ''), toRedisString(result[1] || ''));
    }
  };
};
