'use strict';

const {documentMember} = require('../../DocService/sources/editorDataRedis/redisKeys');

async function readDocumentIndexScore(data, ctx, docId) {
  return data._command(['ZSCORE', data._indexKeys(ctx, docId).documents, documentMember(ctx, docId)]);
}

async function readPresenceKeyCount(data, ctx, docId) {
  const keys = data._docKeys(ctx, docId);
  return data._command(['EXISTS', keys.presenceSet, keys.presenceHash, keys.presenceVersion]);
}

async function seedDocumentState(data, ctx, docId) {
  await data.lockSave(ctx, docId, 'save-owner', 30);
  await data.lockAuth(ctx, docId, 'auth-owner', 30);
  await data.addLocks(ctx, docId, {object: {owner: 'replica'}});
  await data.addMessage(ctx, docId, {owner: 'replica'});
  await data.setSaved(ctx, docId, '1');
  await data.setForceSave(ctx, docId, 1, 1, 'https://example.test', {owner: 'replica'}, null);
  await data.addForceSaveTimerNX(ctx, docId, Date.now() + 60000);
}

async function readDocumentState(data, ctx, docId) {
  const keys = data._docKeys(ctx, docId);
  const indexKeys = data._indexKeys(ctx, docId);
  const [saveLock, authLock, saved, savedClaim, timer, locks, messages, forceSave] = await Promise.all([
    data._command(['GET', keys.saveLock]),
    data._command(['GET', keys.authLock]),
    data._command(['GET', keys.saved]),
    data._command(['HGET', keys.savedClaim, 'id']),
    data._command(['ZSCORE', indexKeys.forceSaveTimer, documentMember(ctx, docId)]),
    data.getLocks(ctx, docId),
    data.getMessages(ctx, docId),
    data.getForceSave(ctx, docId)
  ]);
  return {saveLock, authLock, saved, savedClaim, timer, locks, messages, forceSave};
}

function emptyDocumentState() {
  return {saveLock: null, authLock: null, saved: null, savedClaim: null, timer: null, locks: {}, messages: [], forceSave: null};
}

module.exports = {emptyDocumentState, readDocumentIndexScore, readDocumentState, readPresenceKeyCount, seedDocumentState};
