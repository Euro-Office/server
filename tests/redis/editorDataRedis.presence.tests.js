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

  test.each(['absent', 'existing', 'replaced'])('preserves a new session force-save timer during cleanup (previous timer: %s)', async timerState => {
    const ctx = context(`presence-cleanup-timer-race-${timerState}`);
    const docId = 'document';
    const info = JSON.stringify({id: 'new-user', connectionId: 'new-connection'});
    const expireAt = Date.now() + 60000;
    const indexKey = stores[0]._indexKeys(ctx, docId).forceSaveTimer;
    const member = documentMember(ctx, docId);
    const syncPresenceIndex = stores[0]._syncPresenceIndex;

    if (timerState !== 'absent') {
      await stores[0].addForceSaveTimerNX(ctx, docId, expireAt);
    }
    stores[0]._syncPresenceIndex = async (...args) => {
      await stores[1].addPresence(ctx, docId, 'new-user', info);
      await stores[1].setForceSave(ctx, docId, 2, 2, 'https://example.test');
      if (timerState === 'replaced') {
        await stores[1]._command(['ZREM', indexKey, member]);
      }
      await stores[1].addForceSaveTimerNX(ctx, docId, expireAt);
      return syncPresenceIndex.apply(stores[0], args);
    };

    try {
      assert.equal(await stores[0].cleanDocumentOnExit(ctx, docId), true);
      assert.deepEqual(await stores[1].getPresence(ctx, docId), [info]);
      assert.equal((await stores[1].getForceSave(ctx, docId)).time, 2);
      assert.equal(Number(await stores[1]._command(['ZSCORE', indexKey, member])), expireAt);
    } finally {
      stores[0]._syncPresenceIndex = syncPresenceIndex;
      await stores[1].removePresence(ctx, docId, 'new-user', 'new-connection');
      await stores[1].cleanDocumentOnExit(ctx, docId);
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

  describe('viewers do not block terminal cleanup', () => {
    const viewerCases = [
      ['a viewer', {id: 'viewer', view: true}],
      ['an editor whose co-authoring was closed', {id: 'closed-editor', view: false, isCloseCoAuthoring: true}]
    ];

    for (const [name, entry] of viewerCases) {
      test(`cleans document state while only ${name} remains and keeps its presence`, async () => {
        const ctx = context(`presence-cleanup-viewer-${entry.id}`);
        const docId = 'document';
        const info = JSON.stringify(entry);

        await stores[1].addPresence(ctx, docId, entry.id, info);
        await seedDocumentState(stores[1], ctx, docId);
        try {
          assert.equal(await stores[0].cleanDocumentOnExit(ctx, docId), true);

          assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
          assert.deepEqual(await readDocumentState(stores[0], ctx, docId), emptyDocumentState());
          const indexKeys = stores[0]._indexKeys(ctx, docId);
          assert.notEqual(await stores[0]._command(['ZSCORE', indexKeys.documents, documentMember(ctx, docId)]), null);
        } finally {
          await stores[1].removePresence(ctx, docId, entry.id);
          await stores[1].cleanDocumentOnExit(ctx, docId);
        }
      });
    }

    test('keeps the in-flight save state on final-viewer cleanup while viewers remain', async () => {
      const ctx = context('presence-cleanup-viewer-preserve');
      const docId = 'document';
      const info = JSON.stringify({id: 'viewer', view: true});

      await stores[1].addPresence(ctx, docId, 'viewer', info);
      await seedDocumentState(stores[1], ctx, docId);
      try {
        const before = await readDocumentState(stores[1], ctx, docId);

        assert.equal(await stores[0].cleanDocumentOnExit(ctx, docId, undefined, {preserveSavedClaim: true}), true);

        assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
        assert.deepEqual(await readDocumentState(stores[0], ctx, docId), {
          ...emptyDocumentState(),
          saved: before.saved,
          forceSave: before.forceSave
        });
      } finally {
        await stores[1].removePresence(ctx, docId, 'viewer');
        await stores[1].cleanDocumentOnExit(ctx, docId);
      }
    });

    const blockingCases = [
      ['an editor next to a viewer', [JSON.stringify({id: 'viewer', view: true}), JSON.stringify({id: 'editor', view: false})]],
      ['an entry without a view flag', [JSON.stringify({id: 'editor'})]],
      ['an entry that is not JSON', ['not-json']],
      ['a JSON value that is not an object', ['"viewer"']]
    ];

    for (const [name, infos] of blockingCases) {
      test(`skips cleanup while ${name} remains`, async () => {
        const ctx = context(`presence-cleanup-blocked-${name.replace(/\W+/g, '-')}`);
        const docId = 'document';

        for (let i = 0; i < infos.length; ++i) {
          await stores[1].addPresence(ctx, docId, `user-${i}`, infos[i]);
        }
        await seedDocumentState(stores[1], ctx, docId);
        try {
          const before = await readDocumentState(stores[1], ctx, docId);

          assert.equal(await stores[0].cleanDocumentOnExit(ctx, docId), false);

          assert.deepEqual((await stores[0].getPresence(ctx, docId)).sort(), [...infos].sort());
          assert.deepEqual(await readDocumentState(stores[0], ctx, docId), before);
        } finally {
          for (let i = 0; i < infos.length; ++i) {
            await stores[1].removePresence(ctx, docId, `user-${i}`);
          }
          await stores[1].cleanDocumentOnExit(ctx, docId);
        }
      });
    }
  });

  describe('documents index after exits and crashes', () => {
    test('a read after presence expired keeps the document for GC', async () => {
      // A replica died: nobody removed the presence, it expired on its own.
      const ctx = context('presence-index-crash-read', {'services.CoAuthoring.expire.presence': 1});
      const docId = 'crashed-document';
      await stores[1].addPresence(ctx, docId, 'editor', JSON.stringify({id: 'editor', view: false}));
      const indexKeys = stores[0]._indexKeys(ctx, docId);
      const member = documentMember(ctx, docId);
      const score = await stores[0]._command(['ZSCORE', indexKeys.documents, member]);
      try {
        await wait(2200);

        assert.deepEqual(await stores[0].getPresence(ctx, docId), []);

        assert.equal(await stores[0]._command(['ZSCORE', indexKeys.documents, member]), score);
        // Nothing cleaned up, so GC must still send the "closed" status.
        assert.equal(await stores[0]._wasDocumentClosed(ctx, docId), false);
      } finally {
        await stores[0]._command(['ZREM', indexKeys.documents, member]);
      }
    });

    test('a clean exit whose index update fails leaves the document marked closed', async () => {
      const ctx = context('presence-index-closed-marker');
      const docId = 'document';
      const indexKeys = stores[0]._indexKeys(ctx, docId);
      const member = documentMember(ctx, docId);
      await stores[0].addPresence(ctx, docId, 'user', JSON.stringify({id: 'user', connectionId: 'c1'}));
      // The index is in another Cluster slot; its shard fails during the exit.
      const sync = stores[0]._syncPresenceIndex;
      stores[0]._syncPresenceIndex = async function (syncCtx, syncDocId, expected, desired) {
        if (desired === '') {
          throw new Error('index shard unavailable');
        }
        return sync.call(this, syncCtx, syncDocId, expected, desired);
      };
      try {
        await assert.rejects(stores[0].removePresence(ctx, docId, 'user', 'c1'), /index shard unavailable/);
        await assert.rejects(stores[0].cleanDocumentOnExit(ctx, docId), /index shard unavailable/);
      } finally {
        stores[0]._syncPresenceIndex = sync;
      }
      try {
        // GC will find this entry; the marker tells it the exit was clean.
        assert.notEqual(await stores[1]._command(['ZSCORE', indexKeys.documents, member]), null);
        assert.equal(await stores[1]._wasDocumentClosed(ctx, docId), true);
        // Two presence TTLs plus one GC claim lease.
        const ttl = await stores[1]._command(['TTL', stores[1]._docKeys(ctx, docId).closed]);
        assert.ok(ttl > 890 && ttl <= 900, `closed marker TTL ${ttl}`);

        // A user joining starts a new session that GC must handle again.
        await stores[1].addPresence(ctx, docId, 'user-2', JSON.stringify({id: 'user-2', connectionId: 'c2'}));
        assert.equal(await stores[1]._wasDocumentClosed(ctx, docId), false);
      } finally {
        await stores[1].removePresence(ctx, docId, 'user-2', 'c2');
        await stores[1].cleanDocumentOnExit(ctx, docId);
        await stores[1]._command(['ZREM', indexKeys.documents, member]);
      }
    });

    test('a presence heartbeat that re-creates an entry removes the closed marker', async () => {
      const ctx = context('presence-index-closed-heartbeat');
      const docId = 'document';
      const info = JSON.stringify({id: 'user', connectionId: 'c1'});
      await stores[0].addPresence(ctx, docId, 'user', info);
      await stores[0].removePresence(ctx, docId, 'user', 'c1');
      assert.equal(await stores[0].cleanDocumentOnExit(ctx, docId), true);
      assert.equal(await stores[0]._wasDocumentClosed(ctx, docId), true);
      try {
        // A heartbeat for an entry that is gone (for example after a Redis
        // restart) re-creates it: the user is still connected.
        await stores[1].updatePresence(ctx, docId, 'user', info);
        assert.equal(await stores[1]._wasDocumentClosed(ctx, docId), false);
      } finally {
        await stores[1].removePresence(ctx, docId, 'user', 'c1');
        await stores[1].cleanDocumentOnExit(ctx, docId);
      }
    });

    test('a failing index update does not fail a presence read', async () => {
      const ctx = context('presence-index-read-failure');
      const docId = 'document';
      const info = JSON.stringify({id: 'user-1', connectionId: 'connection-1'});
      await stores[0].addPresence(ctx, docId, 'user-1', info);
      const sync = stores[1]._syncPresenceIndex;
      stores[1]._syncPresenceIndex = async () => {
        throw new Error('index shard unavailable');
      };
      try {
        assert.deepEqual(await stores[1].getPresence(ctx, docId), [info]);
      } finally {
        stores[1]._syncPresenceIndex = sync;
        await stores[0].removePresence(ctx, docId, 'user-1');
        await stores[0].cleanDocumentOnExit(ctx, docId);
      }
    });

    test('removes the documents index entry when the user who refreshed first leaves last', async () => {
      const ctx = context('presence-index-two-users');
      const docId = 'document';
      await stores[0].addPresence(ctx, docId, 'x', JSON.stringify({id: 'x', connectionId: 'cx'}));
      await wait(20);
      await stores[1].addPresence(ctx, docId, 'y', JSON.stringify({id: 'y', connectionId: 'cy'}));
      const indexKeys = stores[0]._indexKeys(ctx, docId);
      const member = documentMember(ctx, docId);

      await stores[1].removePresence(ctx, docId, 'y', 'cy');
      await stores[0].removePresence(ctx, docId, 'x', 'cx');
      await stores[0].removePresenceDocument(ctx, docId);
      assert.equal(await stores[0].cleanDocumentOnExit(ctx, docId), true);

      // Otherwise GC later finds the closed document and sends a second
      // "closed" status callback for it.
      assert.equal(await stores[0]._command(['ZSCORE', indexKeys.documents, member]), null);
    });

    test('keeps the documents index entry when another replica joins after the last exit', async () => {
      const ctx = context('presence-index-rejoin');
      const docId = 'document';
      await stores[0].addPresence(ctx, docId, 'x', JSON.stringify({id: 'x', connectionId: 'cx'}));
      const indexKeys = stores[0]._indexKeys(ctx, docId);
      const member = documentMember(ctx, docId);
      // The exit's removal script ran, but its index update is delayed until
      // after another replica added presence and updated the index.
      const version = await stores[0]._command(['GET', stores[0]._docKeys(ctx, docId).presenceVersion]);
      await stores[0].removePresence(ctx, docId, 'x', 'cx');
      await wait(20);
      await stores[1].addPresence(ctx, docId, 'z', JSON.stringify({id: 'z', connectionId: 'cz'}));
      const joined = await stores[0]._command(['ZSCORE', indexKeys.documents, member]);
      try {
        await stores[0]._syncPresenceIndex(ctx, docId, version, '');

        assert.equal(await stores[0]._command(['ZSCORE', indexKeys.documents, member]), joined);
      } finally {
        await stores[1].removePresence(ctx, docId, 'z', 'cz');
        await stores[1].cleanDocumentOnExit(ctx, docId);
      }
    });
  });

  describe('user names with a lone UTF-16 surrogate', () => {
    // fillUsername cuts names at 255 UTF-16 units, which can split an emoji;
    // JSON.stringify then writes the half as a \udXXX escape.
    const username = ('x'.repeat(254) + '\u{1F600}').substr(0, 255);

    test('removePresence removes the entry of that connection', async () => {
      const ctx = context('presence-lone-surrogate-remove');
      const docId = 'document';
      const info = JSON.stringify({id: 'user-1', username, connectionId: 'connection-1'});
      assert.match(info, /\\ud83d"/);

      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[1].removePresence(ctx, docId, 'user-1', 'connection-1');
      try {
        assert.deepEqual(await stores[0].getPresence(ctx, docId), []);
      } finally {
        await stores[0].cleanDocumentOnExit(ctx, docId);
      }
    });

    test('removePresence still ignores another connection of that user', async () => {
      const ctx = context('presence-lone-surrogate-other');
      const docId = 'document';
      const info = JSON.stringify({id: 'user-1', username, connectionId: 'connection-2'});

      await stores[0].addPresence(ctx, docId, 'user-1', info);
      await stores[1].removePresence(ctx, docId, 'user-1', 'connection-1');
      try {
        assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      } finally {
        await stores[0].removePresence(ctx, docId, 'user-1');
        await stores[0].cleanDocumentOnExit(ctx, docId);
      }
    });

    test('cleanup treats such a viewer as a viewer', async () => {
      const ctx = context('presence-lone-surrogate-viewer');
      const docId = 'document';
      const info = JSON.stringify({id: 'viewer', username, view: true});

      await stores[0].addPresence(ctx, docId, 'viewer', info);
      try {
        assert.equal(await stores[1].cleanDocumentOnExit(ctx, docId), true);
        assert.deepEqual(await stores[0].getPresence(ctx, docId), [info]);
      } finally {
        await stores[0].removePresence(ctx, docId, 'viewer');
        await stores[0].cleanDocumentOnExit(ctx, docId);
      }
    });
  });

  test('raises a tenant presence or shard TTL that would expire between two refreshes', async () => {
    const {setDocumentsExpireStepMs} = require('../../DocService/sources/expirationConfig');
    const {EditorStat} = require('../../DocService/sources/editorDataRedis');
    const stat = new EditorStat();
    // gc.js sets the refresh interval at startup: here 2 minutes. A tenant TTL
    // is raised to at least twice that.
    setDocumentsExpireStepMs(120000);
    try {
      for (const [tenantTtl, expected] of [
        [60, 240],
        [600, 600]
      ]) {
        const ctx = context(`presence-refreshed-ttl-${tenantTtl}`, {
          'services.CoAuthoring.expire.presence': tenantTtl,
          'services.CoAuthoring.expire.shard': tenantTtl
        });
        await stores[0].addPresence(ctx, 'document', 'user', JSON.stringify({id: 'user'}));
        await stat.setEditorConnectionsCountByShard(ctx, 'shard', 1);
        try {
          const presenceTtl = await stores[0]._command(['TTL', stores[0]._docKeys(ctx, 'document').presenceHash]);
          const shardTtl = await stat._command(['TTL', stat._shardKeys(ctx, 'edit').count]);
          assert.ok(presenceTtl > expected - 5 && presenceTtl <= expected, `presence TTL ${presenceTtl} for ${tenantTtl}`);
          assert.ok(shardTtl > expected - 5 && shardTtl <= expected, `shard TTL ${shardTtl} for ${tenantTtl}`);
        } finally {
          await stores[0].removePresence(ctx, 'document', 'user');
          await stores[0].cleanDocumentOnExit(ctx, 'document');
          await stat._command(['DEL', stat._shardKeys(ctx, 'edit').count, stat._shardKeys(ctx, 'edit').updated]);
        }
      }
    } finally {
      setDocumentsExpireStepMs(undefined);
      await stat.close();
    }
  });
});
