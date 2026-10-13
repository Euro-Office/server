'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {documentMember} = require('../../DocService/sources/editorDataRedis/redisKeys');
const {emptyDocumentState, readDocumentState, seedDocumentState} = require('./documentStateHelpers');
const {context, wait} = require('./testHelpers');

async function withClockOffset(offset, operation) {
  const originalNow = Date.now;
  Date.now = () => originalNow() + offset;
  try {
    return await operation();
  } finally {
    Date.now = originalNow;
  }
}

async function redisTimeMilliseconds(data) {
  const time = await data._command(['TIME']);
  return Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
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

    try {
      await stores[0].addPresence(ctx, 'document', 'user-1', info);

      assert.deepEqual(await stores[1].getPresence(ctx, 'document'), [info]);
    } finally {
      await stores[0].removePresence(ctx, 'document', 'user-1');
      await stores[0].cleanDocumentOnExit(ctx, 'document');
    }
  });

  test('does not expire live presence when another replica clock is ahead', async () => {
    const ctx = context('presence-clock-skew-live', {'services.CoAuthoring.expire.presence': 2});
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});

    try {
      await withClockOffset(0, () => stores[0].addPresence(ctx, docId, 'user-1', info));

      const result = await withClockOffset(120000, async () => {
        assert.deepEqual(await stores[1].getPresence(ctx, docId), [info]);
        assert.deepEqual(await stores[1].getDocumentPresenceExpired(), []);
        await stores[1].cleanDocumentOnExit(ctx, docId);
        return stores[1].getPresence(ctx, docId);
      });
      assert.deepEqual(result, [info]);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('refreshes presence TTL and index expiry using Redis time', async () => {
    const ctx = context('presence-clock-skew-refresh', {'services.CoAuthoring.expire.presence': 2});
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
    const keys = stores[0]._docKeys(ctx, docId);
    const indexKey = stores[0]._indexKeys(ctx, docId).documents;
    const member = documentMember(ctx, docId);

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await wait(200);
      await withClockOffset(120000, () => stores[1].updatePresence(ctx, docId, 'user-1', info));

      const serverNow = await redisTimeMilliseconds(stores[0]);
      const score = Number(await stores[0]._command(['ZSCORE', indexKey, member]));
      assert.ok(score >= serverNow + 1500 && score <= serverNow + 3000);
      assert.ok(Number(await stores[0]._command(['PTTL', keys.presenceHash])) > 1000);
      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('expires presence and cleans the document through the bounded GC claim', async () => {
    const ctx = context('presence-expired-gc', {'services.CoAuthoring.expire.presence': 1});
    const docId = 'document';

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', JSON.stringify({id: 'user-1'}));
      await seedDocumentState(stores[0], ctx, docId);
      await wait(1100);

      const expired = await stores[1].getDocumentPresenceExpired();
      assert.deepEqual(expired, [['presence-expired-gc', docId]]);

      await stores[1].cleanDocumentOnExit(ctx, docId);
      assert.equal(await stores[1]._ackDocumentPresenceExpired(expired[0]), true);
      assert.deepEqual(await stores[0].getPresence(ctx, docId), []);
      assert.deepEqual(await readDocumentState(stores[0], ctx, docId), emptyDocumentState());
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('public presence and force-save timer writes use the document index shard', async () => {
    const ctx = context('presence-index-shard-write');
    const docId = 'document';
    const member = documentMember(ctx, docId);
    const indexKeys = stores[0]._indexKeys(ctx, docId);

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', JSON.stringify({id: 'user-1'}));
      await stores[0].addForceSaveTimerNX(ctx, docId, Date.now() + 60000);

      assert.notEqual(await stores[1]._command(['ZSCORE', indexKeys.documents, member]), null);
      assert.notEqual(await stores[1]._command(['ZSCORE', indexKeys.forceSaveTimer, member]), null);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('a refresh after explicit removal does not resurrect the user', async () => {
    const ctx = context('presence-remove-refresh');
    const info = JSON.stringify({id: 'user-1'});

    try {
      await stores[0].addPresence(ctx, 'document', 'user-1', info);
      await stores[0].removePresence(ctx, 'document', 'user-1');

      assert.equal(await stores[1].updatePresence(ctx, 'document', 'user-1'), undefined);
      assert.deepEqual(await stores[0].getPresence(ctx, 'document'), []);
    } finally {
      await stores[0].removePresence(ctx, 'document', 'user-1');
      await stores[0].cleanDocumentOnExit(ctx, 'document');
    }
  });

  test('rebuilds presence and its document index after Redis presence data loss', async () => {
    const ctx = context('presence-recovery');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
    const keys = stores[0]._docKeys(ctx, docId);
    const member = documentMember(ctx, docId);

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[1]._command(['DEL', keys.presenceSet, keys.presenceHash, keys.presenceVersion]);

      await stores[1].updatePresence(ctx, docId, 'user-1', info);

      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      assert.ok((await stores[0]._command(['TTL', keys.presenceSet])) > 0);
      assert.ok((await stores[0]._command(['TTL', keys.presenceHash])) > 0);
      assert.notEqual(await stores[0]._command(['ZSCORE', stores[0]._indexKeys(ctx, docId).documents, member]), null);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('refreshes a missing presence entry only when the connection data is supplied', async () => {
    const ctx = context('presence-refresh-recovery');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
    const keys = stores[0]._docKeys(ctx, docId);

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[0]._command(['DEL', keys.presenceHash]);

      await stores[1].updatePresence(ctx, docId, 'user-1');
      assert.deepEqual(await stores[0].getPresence(ctx, docId), []);

      await stores[1].updatePresence(ctx, docId, 'user-1', info);
      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('an older connection cannot remove a newer connection presence', async () => {
    const ctx = context('presence-connection-race');
    const docId = 'document';
    const oldInfo = JSON.stringify({id: 'user-1', connectionId: 'old-connection'});
    const newInfo = JSON.stringify({id: 'user-1', connectionId: 'new-connection'});
    const member = documentMember(ctx, docId);
    const indexKey = stores[0]._indexKeys(ctx, docId).documents;

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', oldInfo);
      await stores[1].addPresence(ctx, docId, 'user-1', newInfo);

      await stores[0].removePresence(ctx, docId, 'user-1', 'old-connection');

      assert.deepEqual(await stores[1].getPresence(ctx, docId), [newInfo]);
      assert.notEqual(await stores[0]._command(['ZSCORE', indexKey, member]), null);

      await stores[0].removePresence(ctx, docId, 'user-1', 'new-connection');
      assert.deepEqual(await stores[1].getPresence(ctx, docId), []);
      assert.equal(await stores[0]._command(['ZSCORE', indexKey, member]), null);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'old-connection');
      await stores[0].removePresence(ctx, docId, 'user-1', 'new-connection');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('concurrent refresh and removal preserve set/hash consistency', async () => {
    const ctx = context('presence-race');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1'});
    const keys = stores[0]._docKeys(ctx, docId);

    try {
      for (let round = 0; round < 25; round++) {
        await stores[0].addPresence(ctx, docId, 'user-1', info);
        await Promise.all([stores[0].updatePresence(ctx, docId, 'user-1'), stores[1].removePresence(ctx, docId, 'user-1')]);

        const members = await stores[0]._command(['ZRANGE', keys.presenceSet, '0', '-1']);
        const fields = await stores[0]._command(['HKEYS', keys.presenceHash]);
        assert.deepEqual(new Set(members), new Set(fields));
      }
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
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
    assert.equal(await stores[1]._command(['ZSCORE', stores[1]._indexKeys(ctx, docId).documents, documentMember(ctx, docId)]), null);
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

  test('requeues a live document when GC cleanup races with an active presence', async () => {
    const ctx = context('presence-gc-live');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
    const member = documentMember(ctx, docId);
    const indexKey = stores[0]._indexKeys(ctx, docId).documents;

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[0]._command(['ZADD', indexKey, '0', member]);

      const expired = await stores[1].getDocumentPresenceExpired(Date.now());
      assert.deepEqual(expired, [['presence-gc-live', docId]]);
      await stores[1].cleanDocumentOnExit(ctx, docId);
      await stores[1]._ackDocumentPresenceExpired(expired[0]);

      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      assert.ok(Number(await stores[0]._command(['ZSCORE', indexKey, member])) > Date.now());
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('keeps a live hash indexed across a presence TTL gap', async () => {
    const ctx = context('presence-ttl-gap');
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
    const keys = stores[0]._docKeys(ctx, docId);
    const indexKey = stores[0]._indexKeys(ctx, docId).documents;
    const member = documentMember(ctx, docId);

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[1]._command(['DEL', keys.presenceSet, keys.presenceVersion]);

      await stores[1].cleanDocumentOnExit(ctx, docId);

      assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      assert.ok(Number(await stores[0]._command(['ZSCORE', indexKey, member])) > Date.now());
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  });

  test('does not regress a newer replica index during version-marker loss', async () => {
    const ctx = context('presence-index-race', {'services.CoAuthoring.expire.presence': 1});
    const docId = 'document';
    const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
    const keys = stores[0]._docKeys(ctx, docId);
    const indexKey = stores[0]._indexKeys(ctx, docId).documents;
    const member = documentMember(ctx, docId);
    const newerExpiry = Date.now() + 60000;

    try {
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[1]._command(['ZADD', indexKey, String(newerExpiry), member]);
      await stores[1]._command(['DEL', keys.presenceSet, keys.presenceVersion]);

      await stores[0].getPresence(ctx, docId);

      assert.ok(Number(await stores[1]._command(['ZSCORE', indexKey, member])) >= newerExpiry);
    } finally {
      await stores[0].removePresence(ctx, docId, 'user-1', 'connection-1');
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
      const indexKeys = stores[0]._indexKeys(ctx, docId);
      assert.notEqual(await stores[0]._command(['ZSCORE', indexKeys.documents, documentMember(ctx, docId)]), null);
      assert.notEqual(await stores[0]._command(['ZSCORE', indexKeys.forceSaveTimer, documentMember(ctx, docId)]), null);
    } finally {
      await stores[1].removePresence(ctx, docId, 'other-replica-user');
      await stores[1].cleanDocumentOnExit(ctx, docId);
    }
  });
});
