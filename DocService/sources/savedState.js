/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// getdelSaved returns null for absence, a string status otherwise, and throws
// when the outcome is unknown. Backends may consume immediately or retain a
// claim under operationId; callers acknowledge a value after cleanup succeeds.
async function consumeSavedState(editorData, ctx, docId, operationId) {
  // Claim once and keep the value until ackSaved.  Post-callback failures can
  // then retry cleanup without losing the result that must be acknowledged.
  const savedValue = await editorData.getdelSaved(ctx, docId, operationId);
  if (savedValue === null) {
    return {success: true, claimed: false};
  }
  if (savedValue !== '1') {
    return {success: false, claimed: true};
  }
  return {success: true, claimed: true};
}

async function getSavedCallbackAccepted(editorData, ctx, docId, operationId) {
  if (typeof editorData.getSavedCallbackAccepted !== 'function') {
    return null;
  }
  return editorData.getSavedCallbackAccepted(ctx, docId, operationId);
}

async function setSavedCallbackAccepted(editorData, ctx, docId, operationId, accepted) {
  if (typeof editorData.setSavedCallbackAccepted !== 'function') {
    return;
  }
  await editorData.setSavedCallbackAccepted(ctx, docId, operationId, accepted);
}

async function clearSavedCallbackAccepted(editorData, ctx, docId, operationId) {
  if (typeof editorData.clearSavedCallbackAccepted !== 'function') {
    return;
  }
  await editorData.clearSavedCallbackAccepted(ctx, docId, operationId);
}

module.exports = {clearSavedCallbackAccepted, consumeSavedState, getSavedCallbackAccepted, setSavedCallbackAccepted};
