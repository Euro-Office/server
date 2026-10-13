/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {CLEAN_DOCUMENT_SCRIPT} = require('../scripts');
const {documentMember} = require('../redisKeys');
const {toRedisString} = require('../redisValueCodec');

function isRedisResultValue(value) {
  return Buffer.isBuffer(value) || typeof value === 'string' || typeof value === 'number';
}

module.exports = function attachCleanup(EditorData) {
  // Cleanup has three saved-claim policies:
  // - an owner passes its operation id, preserving the claim until it can ack;
  // - claim-less terminal cleanup recovers/deletes an abandoned claim;
  // - final-viewer cleanup passes preserveSavedClaim, because a callback may
  //   still be active even though no presence remains. The claim lease then
  //   provides the recovery boundary if that callback is abandoned.
  EditorData.prototype.cleanDocumentOnExit = async function (ctx, docId, savedClaimId, cleanupOptions) {
    const preserveSavedClaim = cleanupOptions?.preserveSavedClaim === true;
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
      ['', savedClaimId === undefined || savedClaimId === null ? '' : String(savedClaimId), preserveSavedClaim ? '1' : '']
    );
    if (!Array.isArray(result)) {
      return false;
    }

    if (!isRedisResultValue(result[0])) {
      return false;
    }

    const resultCodeString = toRedisString(result[0]);
    if (!/^[0-3]$/.test(resultCodeString)) {
      return false;
    }

    const resultCode = Number(resultCodeString);
    const minimumResultLength = resultCode === 0 ? 3 : 2;
    if (result.length < minimumResultLength) {
      return false;
    }
    if (!isRedisResultValue(result[1]) || (resultCode === 0 && !isRedisResultValue(result[2]))) {
      return false;
    }
    if (resultCode === 2) {
      return false;
    }
    if (resultCode === 1 || resultCode === 3) {
      await this._syncPresenceIndex(ctx, docId, toRedisString(result[1] || ''), '');
      await this._command(['ZREM', this._indexKeys(ctx, docId).forceSaveTimer, documentMember(ctx, docId)]);
      return true;
    }

    await this._syncPresenceIndex(ctx, docId, toRedisString(result[2] || ''), toRedisString(result[1] || ''));
    return false;
  };
};
