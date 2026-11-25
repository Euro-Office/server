'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {context, wait} = require('./testHelpers');

// A user whose DocService process died: their presence entry stops being
// refreshed and expires, and their locks stay. A user who stays refreshes theirs.
const PRESENCE_TTL = 'services.CoAuthoring.expire.presence';

function lock(user, block) {
  return {time: 1, user, block};
}

function presence(id) {
  return JSON.stringify({id, connectionId: `connection-${id}`});
}

describe('editorDataRedis release of absent users', () => {
  let stores;

  beforeEach(() => {
    stores = [new EditorData(), new EditorData()];
  });

  afterEach(async () => {
    await Promise.all(stores.map(store => store.close()));
  });

  // userA joins with a 1 s presence TTL and userB with 60 s; after the wait only
  // userA's entry has expired.
  async function withGoneAndStayingUser(tenant, docId, userA, userB, locks, operation) {
    const gone = context(tenant, {[PRESENCE_TTL]: 1});
    const ctx = context(tenant, {[PRESENCE_TTL]: 60});
    try {
      await stores[0].addPresence(gone, docId, userA, presence(userA));
      await stores[1].addPresence(ctx, docId, userB, presence(userB));
      await stores[0].addLocksNX(ctx, docId, locks);
      await wait(1100);
      await operation(ctx);
    } finally {
      await stores[0].removeAllLocks(ctx, docId);
      await stores[0].removePresence(ctx, docId, userA);
      await stores[0].removePresence(ctx, docId, userB);
      await stores[0].cleanDocumentOnExit(ctx, docId);
    }
  }

  test('releases the locks and presence of a user whose presence expired while another user stays', async () => {
    const locks = {blockA: lock('user-a', 'blockA'), blockA2: lock('user-a', 'blockA2'), blockB: lock('user-b', 'blockB')};
    await withGoneAndStayingUser('absent-release', 'document', 'user-a', 'user-b', locks, async ctx => {
      const result = await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      assert.deepEqual(result.expiredUsers, ['user-a']);
      assert.deepEqual(
        result.locks.sort((a, b) => a.block.localeCompare(b.block)),
        [locks.blockA, locks.blockA2]
      );
      assert.deepEqual(result.presence, [presence('user-b')]);
      assert.deepEqual(await stores[0].getLocks(ctx, 'document'), {blockB: locks.blockB});
      assert.deepEqual(await stores[0].getPresence(ctx, 'document'), [presence('user-b')]);
      // A second pass finds nothing left to release.
      assert.deepEqual(await stores[0]._releaseAbsentUsers(ctx, 'document', []), {
        expiredUsers: [],
        locks: [],
        presence: [presence('user-b')]
      });
    });
  });

  test('a released block can be locked by the user who stayed', async () => {
    const locks = {block: lock('user-a', 'block')};
    await withGoneAndStayingUser('absent-relock', 'document', 'user-a', 'user-b', locks, async ctx => {
      const blocked = await stores[1].addLocksNX(ctx, 'document', {block: lock('user-b', 'block')});
      assert.deepEqual(Object.keys(blocked.lockConflict), ['block']);

      await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      const granted = await stores[1].addLocksNX(ctx, 'document', {block: lock('user-b', 'block')});
      assert.deepEqual(granted.lockConflict, {});
      assert.deepEqual(granted.allLocks, {block: lock('user-b', 'block')});
    });
  });

  test('keeps every lock while their owners are present', async () => {
    const ctx = context('absent-live', {[PRESENCE_TTL]: 60});
    const locks = {blockA: lock('user-a', 'blockA'), blockB: lock('user-b', 'blockB')};
    try {
      await stores[0].addPresence(ctx, 'document', 'user-a', presence('user-a'));
      await stores[1].addPresence(ctx, 'document', 'user-b', presence('user-b'));
      await stores[0].addLocksNX(ctx, 'document', locks);

      const result = await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      assert.deepEqual(result.expiredUsers, []);
      assert.deepEqual(result.locks, []);
      assert.deepEqual(await stores[0].getLocks(ctx, 'document'), locks);
    } finally {
      await stores[0].removeAllLocks(ctx, 'document');
      await stores[0].removePresence(ctx, 'document', 'user-a');
      await stores[0].removePresence(ctx, 'document', 'user-b');
      await stores[0].cleanDocumentOnExit(ctx, 'document');
    }
  });

  test('keeps the locks of a user connected to the calling process although their presence expired', async () => {
    const locks = {blockA: lock('user-a', 'blockA')};
    await withGoneAndStayingUser('absent-local', 'document', 'user-a', 'user-b', locks, async ctx => {
      const result = await stores[0]._releaseAbsentUsers(ctx, 'document', ['user-a']);

      assert.deepEqual(result.expiredUsers, ['user-a']);
      assert.deepEqual(result.locks, []);
      assert.deepEqual(await stores[0].getLocks(ctx, 'document'), locks);
    });
  });

  test('releases nothing when no presence is left: the whole document is GC work', async () => {
    const ctx = context('absent-none-left', {[PRESENCE_TTL]: 1});
    const locks = {blockA: lock('user-a', 'blockA'), blockB: lock('user-b', 'blockB')};
    try {
      await stores[0].addPresence(ctx, 'document', 'user-a', presence('user-a'));
      await stores[0].addPresence(ctx, 'document', 'user-b', presence('user-b'));
      await stores[0].addLocksNX(ctx, 'document', locks);
      await wait(1100);

      const result = await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      assert.deepEqual(result.locks, []);
      assert.deepEqual(result.presence, []);
      assert.deepEqual(await stores[0].getLocks(ctx, 'document'), locks);
    } finally {
      await stores[0].removeAllLocks(ctx, 'document');
      await stores[0].cleanDocumentOnExit(ctx, 'document');
    }
  });

  test('releases nothing while a presence entry cannot be read', async () => {
    const gone = context('absent-unreadable', {[PRESENCE_TTL]: 1});
    const ctx = context('absent-unreadable', {[PRESENCE_TTL]: 60});
    const locks = {blockA: lock('user-a', 'blockA')};
    try {
      await stores[0].addPresence(gone, 'document', 'user-a', presence('user-a'));
      await stores[0].addPresence(ctx, 'document', 'user-b', 'not json');
      await stores[0].addLocksNX(ctx, 'document', locks);
      await wait(1100);

      const result = await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      assert.deepEqual(result.expiredUsers, ['user-a']);
      assert.deepEqual(result.locks, []);
      assert.deepEqual(await stores[0].getLocks(ctx, 'document'), locks);
    } finally {
      await stores[0].removeAllLocks(ctx, 'document');
      await stores[0].removePresence(ctx, 'document', 'user-b');
      await stores[0].cleanDocumentOnExit(ctx, 'document');
    }
  });

  test('keeps a lock whose owner cannot be read', async () => {
    const locks = {blockA: lock('user-a', 'blockA'), noUser: {time: 1, block: 'noUser'}, numericUser: lock(7, 'numericUser')};
    await withGoneAndStayingUser('absent-unknown-owner', 'document', 'user-a', 'user-b', locks, async ctx => {
      await stores[0]._command(['HSET', stores[0]._docKeys(ctx, 'document').locks, 'garbage', '{not json']);

      const result = await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      assert.deepEqual(result.locks, [locks.blockA]);
      const left = await stores[0].getLocks(ctx, 'document');
      assert.deepEqual(Object.keys(left).sort(), ['garbage', 'noUser', 'numericUser']);
    });
  });

  test('matches user ids with quotes, emoji and a lone surrogate', async () => {
    const userA = 'gone "a" \\ \u{1F600} \ud800';
    const userB = 'stays "b" \\ \u{1F600} \udc00';
    const locks = {blockA: lock(userA, 'blockA'), blockB: lock(userB, 'blockB')};
    await withGoneAndStayingUser('absent-ids', 'document', userA, userB, locks, async ctx => {
      const result = await stores[1]._releaseAbsentUsers(ctx, 'document', []);

      assert.deepEqual(result.expiredUsers, [userA]);
      assert.deepEqual(result.locks, [locks.blockA]);
      assert.deepEqual(await stores[0].getLocks(ctx, 'document'), {blockB: locks.blockB});
    });
  });

  test('does nothing on a document without presence or locks', async () => {
    const ctx = context('absent-empty');
    assert.deepEqual(await stores[0]._releaseAbsentUsers(ctx, 'document', ['user-a']), {expiredUsers: [], locks: [], presence: []});
  });
});
