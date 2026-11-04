/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Final-save contract that every editorData backend must implement (memory
// and Redis both do):
// - getdelSaved(ctx, docId, operationId) claims the saved status for one
//   operation.  It returns null (or undefined) when there is none, the status string
//   otherwise, and throws when the outcome is unknown.  A retry of the same
//   operation gets the same value until ackSaved(ctx, docId, operationId).
// - get/set/clearSavedCallbackAccepted(ctx, docId, operationId[, accepted])
//   keep the accepted-callback marker for the same operation.  canvasservice
//   calls them on editorData directly.
// - cleanDocumentOnExit(ctx, docId, savedClaimId) resolves to true only once
//   the backend cleanup has completed.  Any other value defers the save.

async function consumeSavedState(editorData, ctx, docId, operationId) {
  // Claim once and keep the value until ackSaved.  Post-callback failures can
  // then retry cleanup without losing the result that must be acknowledged.
  const savedValue = await editorData.getdelSaved(ctx, docId, operationId);
  if (savedValue === null || savedValue === undefined) {
    return {success: true, claimed: false};
  }
  if (savedValue !== '1') {
    return {success: false, claimed: true};
  }
  return {success: true, claimed: true};
}

module.exports = {consumeSavedState};
