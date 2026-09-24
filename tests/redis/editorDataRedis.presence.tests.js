'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

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
});
