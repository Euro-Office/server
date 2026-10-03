'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData, SavedStateUnknownError} = require('../../DocService/sources/editorDataRedis');
const {documentMember} = require('../../DocService/sources/editorDataRedis/redisKeys');
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
    const claimKey = stores[0]._docKeys(ctx, docId).savedClaim;
    assert.equal(await stores[0]._command(['HGET', claimKey, 'state']), 'resolved');
    assert.equal(await stores[0]._command(['HGET', claimKey, 'value']), null);
    assert.ok((await stores[0]._command(['PTTL', claimKey])) > 0);
    assert.equal(await stores[0].ackSaved(ctx, docId, operationId), true);
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), null);
  });

  test('acknowledges concurrent duplicate acknowledgements atomically', async () => {
    const ctx = context('saved-claim-ack-concurrent');
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');

    const [firstResult, secondResult] = await Promise.all([stores[0].ackSaved(ctx, docId, operationId), stores[1].ackSaved(ctx, docId, operationId)]);

    assert.equal(firstResult, true);
    assert.equal(secondResult, true);
  });

  test('does not let a stale acknowledgement affect a newer claim', async () => {
    const ctx = context('saved-claim-ack-stale');
    const docId = 'document';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-a'), '1');
    await stores[0].ackSaved(ctx, docId, 'operation-a');

    await stores[1].setSaved(ctx, docId, '0');
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), '0');
    await assert.rejects(stores[0].ackSaved(ctx, docId, 'operation-a'), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), '0');
    await stores[1].ackSaved(ctx, docId, 'operation-b');
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

  test('expires an abandoned claim and allows a later saved state to recover', async () => {
    const ctx = context('saved-claim-ttl', {
      'services.CoAuthoring.expire.saved': 1,
      'services.CoAuthoring.expire.savedClaim': 1
    });
    const docId = 'document';
    const operationId = 'operation-a';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    const claimKey = stores[0]._docKeys(ctx, docId).savedClaim;
    assert.ok((await stores[0]._command(['PTTL', claimKey])) > 0);
    await wait(1200);

    assert.equal(await stores[1]._command(['EXISTS', claimKey]), 0);
    await assert.rejects(stores[1].ackSaved(ctx, docId, operationId), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');
    await stores[1].setSaved(ctx, docId, '0');
    assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), '0');
    await stores[1].ackSaved(ctx, docId, 'operation-b');
  });

  test('uses a separate longer lease for saved-state claims', async () => {
    const ctx = context('saved-claim-separate-ttl', {
      'services.CoAuthoring.expire.saved': 1,
      'services.CoAuthoring.expire.savedClaim': 10
    });
    const docId = 'document';

    await stores[0].setSaved(ctx, docId, '1');
    assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-a'), '1');
    const keys = stores[0]._docKeys(ctx, docId);

    assert.equal(await stores[0]._command(['TTL', keys.saved]), -2);
    assert.ok((await stores[0]._command(['TTL', keys.savedClaim])) >= 9);
    await stores[0].ackSaved(ctx, docId, 'operation-a');
  });

  test('migrates a legacy claim without a TTL', async () => {
    const ctx = context('saved-claim-legacy', {'services.CoAuthoring.expire.savedClaim': 10});
    const docId = 'document';
    const operationId = 'operation-a';
    const keys = stores[0]._docKeys(ctx, docId);

    await stores[0]._command(['HSET', keys.savedClaim, 'id', operationId, 'value', '1']);
    assert.equal(await stores[0]._command(['TTL', keys.savedClaim]), -1);
    assert.equal(await stores[0].getdelSaved(ctx, docId, operationId), '1');
    assert.ok((await stores[0]._command(['TTL', keys.savedClaim])) >= 9);
    await stores[0].ackSaved(ctx, docId, operationId);
  });

  test('does not let stale cleanup delete a newer saved-state claim', async () => {
    const ctx = context('saved-claim-stale-cleanup', {
      'services.CoAuthoring.expire.saved': 1,
      'services.CoAuthoring.expire.savedClaim': 1
    });
    const docId = 'document';
    const indexKeys = stores[0]._indexKeys(ctx, docId);
    const member = documentMember(ctx, docId);

    try {
      await stores[0].addPresence(ctx, docId, 'user-a', JSON.stringify({id: 'user-a'}));
      await stores[0].setSaved(ctx, docId, '1');
      assert.equal(await stores[0].getdelSaved(ctx, docId, 'operation-a'), '1');
      await stores[0].removePresence(ctx, docId, 'user-a');
      await stores[0].addForceSaveTimerNX(ctx, docId, 12345);
      await wait(1200);

      await stores[1].setSaved(ctx, docId, '0');
      assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), '0');

      assert.equal(await stores[0]._command(['ZSCORE', indexKeys.documents, member]), null);

      await stores[0].cleanDocumentOnExit(ctx, docId, 'operation-a');

      assert.equal(await stores[0]._command(['ZSCORE', indexKeys.documents, member]), null);
      assert.equal(await stores[0]._command(['ZSCORE', indexKeys.forceSaveTimer, member]), '12345');
      assert.equal(await stores[1].getdelSaved(ctx, docId, 'operation-b'), '0');
      await stores[1].ackSaved(ctx, docId, 'operation-b');
    } finally {
      await stores[0]._command(['ZREM', indexKeys.forceSaveTimer, member]);
    }
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

  test('rejects an unknown or malformed acknowledgement without changing a claim', async () => {
    const ctx = context('saved-claim-ack-invalid');
    const docId = 'document';

    await assert.rejects(stores[0].ackSaved(ctx, docId, 'unknown-operation'), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');

    const malformedDocId = 'malformed-document';
    const malformedKey = stores[0]._docKeys(ctx, malformedDocId).savedClaim;
    await stores[0]._command(['HSET', malformedKey, 'id', 'operation-a', 'state', 'pending']);
    await stores[0]._command(['EXPIRE', malformedKey, '10']);
    await assert.rejects(stores[0].ackSaved(ctx, malformedDocId, 'operation-a'), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');
    assert.equal(await stores[0]._command(['EXISTS', malformedKey]), 1);

    await stores[0]._command(['HSET', malformedKey, 'id', 'operation-a', 'state', 'resolved', 'value', '1']);
    await assert.rejects(stores[0].ackSaved(ctx, malformedDocId, 'operation-a'), error => error.code === 'EDITOR_DATA_SAVED_UNKNOWN');
    assert.equal(await stores[0]._command(['HGET', malformedKey, 'state']), 'resolved');
    assert.equal(await stores[0]._command(['HGET', malformedKey, 'value']), '1');
  });
});
