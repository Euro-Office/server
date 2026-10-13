/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const EditorData = require('./editorData/base');
const attachPresence = require('./editorData/presence');
const attachExpiredQueue = require('./editorData/expiredQueue');
const attachLocks = require('./editorData/locks');
const attachMessages = require('./editorData/messages');
const attachSavedState = require('./editorData/savedState');
const attachForceSave = require('./editorData/forceSave');
const attachCleanup = require('./editorData/cleanup');

attachPresence(EditorData);
attachExpiredQueue(EditorData);
attachLocks(EditorData);
attachMessages(EditorData);
attachSavedState(EditorData);
attachForceSave(EditorData);
attachCleanup(EditorData);

module.exports = EditorData;
module.exports.SavedStateUnknownError = attachSavedState.SavedStateUnknownError;
