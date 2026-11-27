/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const operationContext = require('./../../Common/sources/operationContext');
const commonDefines = require('./../../Common/sources/commondefines');

// A DocService process that dies (killed, out of memory, lost node), or exits
// while keeping its users' editor data for their reconnect (see the
// 'disconnect' handler), never runs closeDocument for its connections. With a
// shared editor-data store their presence entries and locks outlive it. A lock
// (expire.locks, 7 days by default) goes only with its user's closeDocument or
// when the last user leaves the document, so a user who does not come back
// keeps the others out of what they had locked (strict co-editing mode).
//
// expireDoc calls release() on every pass. For each document open in this
// process, the store drops the expired presence entries and the locks of the
// users who are no longer present, and the users who remain are told, as
// closeDocument tells them when a user leaves. A user is gone once their
// presence entry has expired (expire.presence after its last refresh), the
// rule GC applies to a whole document.

function localDocuments(connections) {
  const documents = new Map();
  for (const conn of connections) {
    if (conn.docId == null || !conn.user) {
      continue;
    }
    const ctx = new operationContext.Context();
    ctx.initFromConnection(conn);
    ctx.setDocId(conn.docId);
    const key = JSON.stringify([ctx.tenant, conn.docId]);
    let document = documents.get(key);
    if (!document) {
      document = {ctx, docId: conn.docId, userIds: new Set()};
      documents.set(key, document);
    }
    document.userIds.add(conn.user.id);
  }
  return [...documents.values()];
}

function participantsOf(presence) {
  const participants = [];
  for (const value of presence) {
    try {
      const entry = JSON.parse(value);
      if (entry && !entry.isCloseCoAuthoring) {
        participants.push(entry);
      }
    } catch (_err) {
      // An entry that cannot be read is left out, as no user can be shown for it.
    }
  }
  return participants;
}

async function releaseDocument(document, editorData, publish) {
  const {ctx, docId, userIds} = document;
  await ctx.initTenantCache();
  const result = await editorData._releaseAbsentUsers(ctx, docId, [...userIds]);
  const locksByUser = new Map();
  for (const lock of result.locks) {
    if (!locksByUser.has(lock.user)) {
      locksByUser.set(lock.user, []);
    }
    locksByUser.get(lock.user).push(lock);
  }
  for (const [userId, locks] of locksByUser) {
    ctx.logger.warn('released %d lock(s) of user %s, who is gone without closing the document', locks.length, userId);
    await publish(ctx, {type: commonDefines.c_oPublishType.releaseLock, ctx, docId, userId, locks}, docId, userId);
  }
  // A user connected here whose presence entry expired (its refresh failed) is
  // still here: the next refresh writes the entry again.
  const goneUsers = new Set(result.expiredUsers.filter(userId => !userIds.has(userId)));
  locksByUser.forEach((_locks, userId) => goneUsers.add(userId));
  if (goneUsers.size > 0) {
    const userId = goneUsers.values().next().value;
    const participants = participantsOf(result.presence);
    const data = {type: commonDefines.c_oPublishType.participantsState, ctx, docId, userId, participantsTimestamp: Date.now(), participants};
    await publish(ctx, data, docId, userId);
  }
}

/**
 * Releases what users who are gone without closing their document left behind,
 * for every document that has a connection in this process.
 * @param {Array<object>} connections - This process's connections
 * @param {object} editorData - Editor-data store; only stores that implement
 *   _releaseAbsentUsers (editorDataRedis) are shared with other processes
 * @param {Function} publish - DocsCoServer publish
 * @returns {Promise<void>} Resolves when every document was handled; a failing
 *   document is logged and does not stop the others
 */
async function release(connections, editorData, publish) {
  if (typeof editorData._releaseAbsentUsers !== 'function') {
    return;
  }
  for (const document of localDocuments(connections)) {
    try {
      await releaseDocument(document, editorData, publish);
    } catch (err) {
      document.ctx.logger.error('releasing what gone users left in the document failed: %s', err?.stack || err);
    }
  }
}

module.exports = {release};
