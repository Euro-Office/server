'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData, SavedStateUnknownError} = require('../../DocService/sources/editorDataRedis');
const {context, wait} = require('./testHelpers');

describe('editorDataRedis saved-state claims', () => {
  let stores;

  beforeEach(() => {
    stores = [new EditorData(), new EditorData()];
  });

  afterEach(async () => {
    await Promise.all(stores.map(store => store.close()));
  });

  test('claims and acknowledges a saved value while preserving normal string results', async () => {
    const ctx = context('saved-claim-normal');
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    assert.equal(await stores[0]._command(['GET', stores[0]._docKeys(ctx, docId).saved]), null);
    assert.equal(await stores[0].ackSaved(ctx, docId, operationId), true);
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), null);
  });

  test('returns null only when the saved key and claim are both absent', async () => {
    const ctx = context('saved-claim-absent');

    assert.equal(await stores[0].getdelSaved(ctx, 'document', 'operation-a'), null);
  });

  test('allows only one concurrent consumer and fails closed for the other consumer', async () => {
    const ctx = context('saved-claim-concurrent');
    const docId = 'document';

    await stores[0].setSaved(ctx, docId, '1');
    const results = await Promise.allSettled([stores[0].getdelSaved(ctx, docId, 'operation-a'), stores[1].getdelSaved(ctx, docId, 'operation-b')]);

    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value === '1').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected);
    assert.equal(rejected.reason instanceof SavedStateUnknownError, true);
    assert.equal(rejected.reason.code, 'EDITOR_DATA_SAVED_UNKNOWN');
  });

  test('propagates a Redis failure without consuming or treating the value as absent', async () => {
    const ctx = context('saved-claim-failure');
    const docId = 'document';
    const keys = stores[0]._docKeys(ctx, docId);

    await stores[0].setSaved(ctx, docId, '1');
    stores[0]._eval = async () => {
      throw new Error('Redis unavailable');
    };

    await assert.rejects(stores[0].getdelSaved(ctx, docId, 'operation-a'), /Redis unavailable/);
    assert.equal(await stores[1]._command(['GET', keys.saved]), '1');
    assert.equal(await stores[1]._command(['EXISTS', keys.savedClaim]), 0);
  });

  test('recovers a committed claim with the same operation id', async () => {
    const ctx = context('saved-claim-recovery');
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].setSaved(ctx, docId, '1');
    const first = await stores[0].getdelSaved(ctx, docId, operationId);
    assert.equal(first, '1');
    assert.equal(await stores[1].getdelSaved(ctx, docId, operationId), '1');
    await assert.rejects(stores[1].getdelSaved(ctx, docId, 'operation-b'), error => {
      assert.equal(error.code, 'EDITOR_DATA_SAVED_UNKNOWN');
      return true;
    });
    await stores[1].ackSaved(ctx, docId, operationId);
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-b'), null);
  });

  test('keeps a committed claim recoverable after the saved key TTL expires', async () => {
    const ctx = context('saved-claim-ttl', {'services.CoAuthoring.expire.saved': 1});
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    await wait(1200);

    assert.equal(await stores[1].getdelSaved(ctx, docId, operationId), '1');
    await stores[1].ackSaved(ctx, docId, operationId);
  });

  test('keeps an outstanding claim while another replica still has presence', async () => {
    const ctx = context('saved-claim-live-cleanup');
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].addPresence(ctx, docId, 'user-a', JSON.stringify({id: 'user-a'}));
    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    await stores[1].cleanDocumentOnExit(ctx, docId);

    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    await stores[0].ackSaved(ctx, docId, operationId);
  });

  test('recovers an abandoned claim during terminal cleanup', async () => {
    const ctx = context('saved-claim-abandoned-cleanup');
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].addPresence(ctx, docId, 'user-a', JSON.stringify({id: 'user-a'}));
    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    await stores[0].removePresence(ctx, docId, 'user-a');
    await stores[1].cleanDocumentOnExit(ctx, docId);

    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-b'), null);
    await stores[0].setSaved(ctx, docId, '0');
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-b'), '0');
    await stores[0].ackSaved(ctx, docId, 'operation-b');
  });

  test('preserves the owner claim during terminal cleanup until it is acknowledged', async () => {
    const ctx = context('saved-claim-owner-cleanup');
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].addPresence(ctx, docId, 'user-a', JSON.stringify({id: 'user-a'}));
    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    await stores[0].removePresence(ctx, docId, 'user-a');
    await stores[1].cleanDocumentOnExit(ctx, docId, operationId);

    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    await stores[0].ackSaved(ctx, docId, operationId);
  });

  test('preserves a newer saved value while an older claim is outstanding', async () => {
    const ctx = context('saved-claim-overwrite');
    const docId = 'document';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-a'), '1');
    await stores[1].setSaved(ctx, docId, '0');

    await assert.rejects(stores[0].getdelSaved(ctx, docId, 'operation-b'), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-a'), '1');
    await stores[1].ackSaved(ctx, docId, 'operation-a');
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-b'), '0');
    await stores[0].ackSaved(ctx, docId, 'operation-b');
  });

  test('does not allow the wrong operation to acknowledge a claim', async () => {
    const ctx = context('saved-claim-ack-owner');
    const docId = 'document';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-a'), '1');
    await assert.rejects(stores[1].ackSaved(ctx, docId, 'operation-b'), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-a'), '1');
    await stores[1].ackSaved(ctx, docId, 'operation-a');
  });
});
