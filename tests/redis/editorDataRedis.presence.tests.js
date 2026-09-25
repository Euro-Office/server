'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {documentMember} = require('../../DocService/sources/editorDataRedis/base');
const {context} = require('./testHelpers');

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
  const [saveLock, authLock, saved, timer, locks, messages, forceSave] = await Promise.all([
    data._command(['GET', keys.saveLock]),
    data._command(['GET', keys.authLock]),
    data._command(['GET', keys.saved]),
    data._command(['ZSCORE', data.forceSaveTimerKey, documentMember(ctx, docId)]),
    data.getLocks(ctx, docId),
    data.getMessages(ctx, docId),
    data.getForceSave(ctx, docId)
  ]);
  return {saveLock, authLock, saved, timer, locks, messages, forceSave};
}

function emptyDocumentState() {
  return {saveLock: null, authLock: null, saved: null, timer: null, locks: {}, messages: [], forceSave: null};
}

describe('editorDataRedis presence invariants', () => {
  let stores;

  beforeEach(() => {
    stores = [new EditorData(), new EditorData()];
  });

  afterEach(async () => {
    await Promise.all(stores.map(store => store.close()));
  });

  test('a presence write on one replica is visible from another replica', async () => {
    const ctx = context('presence-cross-replica');
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});

    await stores[0].addPresence(ctx, 'document', 'user-1', info);

    assert.deepEqual(await stores[1].getPresence(ctx, 'document'), [info]);
  });

  test('a refresh after explicit removal does not resurrect the user', async () => {
    const ctx = context('presence-remove-refresh');
    const info = JSON.stringify({id: 'user-1'});

    await stores[0].addPresence(ctx, 'document', 'user-1', info);
    await stores[0].removePresence(ctx, 'document', 'user-1');

    assert.equal(await stores[1].updatePresence(ctx, 'document', 'user-1'), undefined);
    assert.deepEqual(await stores[0].getPresence(ctx, 'document'), []);
  });

  test('concurrent refresh and removal preserve set/hash consistency', async () => {
    const ctx = context('presence-race');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1'});
    const keys = stores[0]._docKeys(ctx, docId);

    for (let round = 0; round < 25; round++) {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await Promise.all([stores[0].updatePresence(ctx, docId, 'user-1'), stores[1].removePresence(ctx, docId, 'user-1')]);

      const members = await stores[0]._command(['ZRANGE', keys.presenceSet, '0', '-1']);
      const fields = await stores[0]._command(['HKEYS', keys.presenceHash]);
      assert.deepEqual(new Set(members), new Set(fields));
    }
  });

  test('document cleanup does not delete presence while a user remains', async () => {
    const ctx = context('presence-cleanup');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1'});

    await stores[0].addPresence(ctx, docId, 'user-1', info);
    await stores[0].removePresenceDocument(ctx, docId);
    assert.deepEqual(await stores[1].getPresence(ctx, docId), [info]);

    await stores[1].removePresence(ctx, docId, 'user-1');
    await stores[0].removePresenceDocument(ctx, docId);
    assert.deepEqual(await stores[1].getPresence(ctx, docId), []);
  });

  test('cleans document state when no live presence remains', async () => {
    const ctx = context('presence-cleanup-last-replica');
    const docId = 'document';

    await stores[0].addPresence(ctx, docId, 'user-1', JSON.stringify({id: 'user-1'}));
    await stores[0].removePresence(ctx, docId, 'user-1');
    await seedDocumentState(stores[0], ctx, docId);

    await stores[0].cleanDocumentOnExit(ctx, docId);

    assert.deepEqual(await stores[1].getPresence(ctx, docId), []);
    assert.deepEqual(await readDocumentState(stores[1], ctx, docId), emptyDocumentState());
    assert.equal(await stores[1]._command(['ZSCORE', stores[1].documentsKey, documentMember(ctx, docId)]), null);
  });

  test('skips cleanup while any live presence entry remains', async () => {
    const ctx = context('presence-cleanup-live');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1'});

    await stores[0].addPresence(ctx, docId, 'user-1', info);
    await seedDocumentState(stores[0], ctx, docId);
    try {
      const before = await readDocumentState(stores[0], ctx, docId);

      await stores[0].cleanDocumentOnExit(ctx, docId);

      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      assert.deepEqual(await readDocumentState(stores[0], ctx, docId), before);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('removes expired presence before deciding whether to clean', async () => {
    const ctx = context('presence-cleanup-expired');
    const docId = 'document';
    const keys = stores[0]._docKeys(ctx, docId);

    await stores[0].addPresence(ctx, docId, 'stale-user', JSON.stringify({id: 'stale-user'}));
    await stores[0]._command(['ZADD', keys.presenceSet, '0', 'stale-user']);
    await seedDocumentState(stores[0], ctx, docId);

    await stores[1].cleanDocumentOnExit(ctx, docId);

    assert.deepEqual(await stores[0].getPresence(ctx, docId), []);
    assert.deepEqual(await readDocumentState(stores[0], ctx, docId), emptyDocumentState());
  });

  test("does not delete another replica's locks and state", async () => {
    const ctx = context('presence-cleanup-replica-state');
    const docId = 'document';
    const info = JSON.stringify({id: 'other-replica-user'});

    await stores[1].addPresence(ctx, docId, 'other-replica-user', info);
    await seedDocumentState(stores[1], ctx, docId);
    try {
      const before = await readDocumentState(stores[1], ctx, docId);

      await stores[0].cleanDocumentOnExit(ctx, docId);

      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      assert.deepEqual(await readDocumentState(stores[0], ctx, docId), before);
      assert.notEqual(await stores[0]._command(['ZSCORE', stores[0].documentsKey, documentMember(ctx, docId)]), null);
      assert.notEqual(await stores[0]._command(['ZSCORE', stores[0].forceSaveTimerKey, documentMember(ctx, docId)]), null);
    } finally {
      await stores[1].removePresence(ctx, docId, 'other-replica-user');
      await stores[1].cleanDocumentOnExit(ctx, docId);
    }
  });
});
