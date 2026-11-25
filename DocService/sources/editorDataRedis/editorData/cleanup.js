/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {randomUUID} = require('crypto');
const {CLEAN_DOCUMENT_SCRIPT, CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT, CLEAN_FORCE_SAVE_TIMER_SCRIPT} = require('../scripts');
const {documentMember, forceSaveTimerCleanupKey} = require('../redisKeys');
const {POP_EXPIRED_LEASE_MS, cfgExpPresence} = require('../editorDataSettings');
const {refreshedTtlSeconds, toRedisString} = require('../redisValueCodec');

function isRedisResultValue(value) {
  return Buffer.isBuffer(value) || typeof value === 'string' || typeof value === 'number';
}

// A documents index entry left behind by a failed index update (the index is in
// another Cluster slot, so it is updated in a second step) expires at most one
// presence TTL after the exit; GC claims it within one documentsCron interval
// (shorter than the presence TTL) and may retry it after one claim lease.
function closedMarkerTtlSeconds(ctx) {
  return 2 * refreshedTtlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence) + Math.ceil(POP_EXPIRED_LEASE_MS / 1000);
}

module.exports = function attachCleanup(EditorData) {
  // True while the document's last cleanup ran and no user joined since. GC
  // then knows that an expired documents index entry is left over from a clean
  // exit (whose "closed" status was sent), not from a replica that died.
  EditorData.prototype._wasDocumentClosed = async function (ctx, docId) {
    return Number(await this._command(['EXISTS', this._docKeys(ctx, docId).closed])) === 1;
  };

  // Cleanup has three saved-claim policies:
  // - an owner passes its operation id, preserving the claim until it can ack;
  // - claim-less terminal cleanup recovers/deletes an abandoned claim;
  // - final-viewer cleanup passes preserveSavedClaim, because a callback may
  //   still be active even though no presence remains. The claim lease then
  //   provides the recovery boundary if that callback is abandoned.
  EditorData.prototype.cleanDocumentOnExit = async function (ctx, docId, savedClaimId, cleanupOptions) {
    const preserveSavedClaim = cleanupOptions?.preserveSavedClaim === true;
    const keys = this._docKeys(ctx, docId);
    const timerCleanupKey = forceSaveTimerCleanupKey(ctx, docId);
    const timerCleanupId = randomUUID();
    // Claim before checking presence. Scheduling revokes this claim atomically
    // in the index slot, even when NX retains the previous timer's deadline.
    // Aborted cleanups leave only a short-lived claim, never a permanent key.
    await this._eval(CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT, [timerCleanupKey], [timerCleanupId, String(POP_EXPIRED_LEASE_MS)]);
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
        keys.forceSave,
        keys.closed
      ],
      [
        '',
        savedClaimId === undefined || savedClaimId === null ? '' : String(savedClaimId),
        preserveSavedClaim ? '1' : '',
        String(closedMarkerTtlSeconds(ctx))
      ]
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
      // Viewers still present keep their presence, so the documents index entry
      // stays too: GC must still see the document if their replica dies.
      const viewersRemain = isRedisResultValue(result[2]) && toRedisString(result[2]) === '1';
      if (!viewersRemain) {
        await this._syncPresenceIndex(ctx, docId, toRedisString(result[1] || ''), '');
      }
      await this._eval(
        CLEAN_FORCE_SAVE_TIMER_SCRIPT,
        [this._indexKeys(ctx, docId).forceSaveTimer, timerCleanupKey],
        [documentMember(ctx, docId), timerCleanupId]
      );
      return true;
    }

    await this._syncPresenceIndex(ctx, docId, toRedisString(result[2] || ''), toRedisString(result[1] || ''));
    return false;
  };
};
