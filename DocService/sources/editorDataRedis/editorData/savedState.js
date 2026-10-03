/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {randomUUID} = require('crypto');

const {CLAIM_SAVED_SCRIPT, ACK_SAVED_SCRIPT} = require('../scripts');
const {cfgExpSaved, cfgExpSavedClaim} = require('../editorDataSettings');
const {ttlSeconds, toRedisString} = require('../redisValueCodec');

class SavedStateUnknownError extends Error {
  constructor(docId) {
    super(`Saved state for document ${docId} has an unresolved Redis claim`);
    this.name = 'SavedStateUnknownError';
    this.code = 'EDITOR_DATA_SAVED_UNKNOWN';
  }
}

module.exports = function attachSavedState(EditorData) {
  EditorData.prototype.setSaved = async function (ctx, docId, status) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.saved', cfgExpSaved);
    await this._command(['SET', this._docKeys(ctx, docId).saved, String(status), 'EX', String(ttl)]);
  };

  /**
   * Claim the saved status for a logical operation.
   *
   * A caller that may retry after a lost Redis reply must pass the same
   * operationId on every attempt.  `null` means that no saved value or claim
   * exists.  An unresolved claim owned by another operation, or an invalid
   * Redis response, throws SavedStateUnknownError instead of being reported as
   * an absent value.
   */
  EditorData.prototype.getdelSaved = async function (ctx, docId, operationId) {
    const keys = this._docKeys(ctx, docId);
    const claimId = operationId === undefined || operationId === null || operationId === '' ? randomUUID() : String(operationId);
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.savedClaim', cfgExpSavedClaim);
    const result = await this._eval(CLAIM_SAVED_SCRIPT, [keys.saved, keys.savedClaim], [claimId, String(ttl)]);
    if (!Array.isArray(result) || result.length === 0) {
      throw new SavedStateUnknownError(docId);
    }
    const state = toRedisString(result[0]);
    if (state === 'absent') {
      return null;
    }
    if (state === 'value' && result.length > 1 && result[1] !== null && result[1] !== undefined) {
      return toRedisString(result[1]);
    }
    throw new SavedStateUnknownError(docId);
  };

  // A successful getdelSaved is a claim, not an acknowledgement.  The caller
  // acknowledges only after it has decided that the saved result is usable.  If
  // the claim response is lost, the same operation id can still recover the
  // value until the claim lease expires; a different operation must fail closed
  // until the claim is resolved.
  EditorData.prototype.ackSaved = async function (ctx, docId, operationId) {
    if (operationId === undefined || operationId === null || operationId === '') {
      throw new SavedStateUnknownError(docId);
    }
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.savedClaim', cfgExpSavedClaim);
    const result = await this._eval(ACK_SAVED_SCRIPT, [this._docKeys(ctx, docId).savedClaim], [String(operationId), String(ttl)]);
    if (Number(result) !== 1 && Number(result) !== 2) {
      throw new SavedStateUnknownError(docId);
    }
    return true;
  };
};

module.exports.SavedStateUnknownError = SavedStateUnknownError;
