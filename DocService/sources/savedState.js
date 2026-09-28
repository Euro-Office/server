/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Resolve the saved status before the caller performs document cleanup.  A
// storage failure or unresolved claim deliberately rejects; neither can be
// interpreted as an absent saved status.  The caller acknowledges a claimed
// value only after that cleanup succeeds.
async function consumeSavedState(editorData, ctx, docId, operationId) {
  const savedValue = await editorData.getdelSaved(ctx, docId, operationId);
  if (savedValue === null) {
    return {success: true, claimed: false};
  }
  if (savedValue !== '1') {
    return {success: false, claimed: true};
  }
  return {success: true, claimed: true};
}

module.exports = {consumeSavedState};
