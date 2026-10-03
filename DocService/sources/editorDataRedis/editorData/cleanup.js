/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {CLEAN_DOCUMENT_SCRIPT} = require('../scripts');
const {documentMember} = require('../redisKeys');
const {toRedisString} = require('../redisValueCodec');

module.exports = function attachCleanup(EditorData) {
  // Terminal cleanup recovers an abandoned saved claim.  A caller that owns the
  // claim passes its operation id so the claim survives cleanup and can be acked
  // after the rest of the operation succeeds.
  EditorData.prototype.cleanDocumentOnExit = async function (ctx, docId, savedClaimId) {
    const keys = this._docKeys(ctx, docId);
    const result = await this._eval(
      CLEAN_DOCUMENT_SCRIPT,
      [
        keys.presenceSet,
        keys.presenceHash,
        keys.presenceVersion,
        keys.saveLock,
        keys.authLock,
        keys.locks,
        keys.messages,
        keys.saved,
        keys.savedClaim,
        keys.forceSave
      ],
      ['', savedClaimId === undefined || savedClaimId === null ? '' : String(savedClaimId)]
    );
    if (result && Number(result[0]) === 2) {
      return;
    }
    if (result && Number(result[0]) === 1) {
      await this._syncPresenceIndex(ctx, docId, toRedisString(result[1] || ''), '');
      await this._command(['ZREM', this._indexKeys(ctx, docId).forceSaveTimer, documentMember(ctx, docId)]);
    } else if (result) {
      await this._syncPresenceIndex(ctx, docId, toRedisString(result[2] || ''), toRedisString(result[1] || ''));
    }
  };
};
