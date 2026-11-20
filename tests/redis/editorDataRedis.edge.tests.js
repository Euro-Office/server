'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {EditorData: MemoryEditorData} = require('../../DocService/sources/editorDataMemory');
const {documentMember} = require('../../DocService/sources/editorDataRedis/redisKeys');
const shardConnectionCounts = require('../../DocService/sources/shardConnectionCounts');
const {context} = require('./testHelpers');

describe('editorDataRedis edge cases', () => {
  let data;
  let stat;

  beforeEach(() => {
    data = new EditorData();
    stat = new EditorStat();
  });

  afterEach(async () => {
    await Promise.all([data.close(), stat.close()]);
  });

  test('empty lock updates are no-ops and return the existing lock state', async () => {
    const ctx = context('empty-lock-input');
    const docId = 'document';

    await data.addLocks(ctx, docId, {});
    assert.deepEqual(await data.getLocks(ctx, docId), {});
    assert.deepEqual(await data.addLocksNX(ctx, docId, {}), {lockConflict: {}, allLocks: {}});
    await data.removeLocks(ctx, docId, {});
    assert.deepEqual(await data.getLocks(ctx, docId), {});
  });

  test('save locks are isolated by tenant even when document IDs match', async () => {
    const first = context('lock-tenant-one');
    const second = context('lock-tenant-two');

    assert.equal(await data.lockSave(first, 'same-document', 'owner-one', 5), true);
    assert.equal(await data.lockSave(second, 'same-document', 'owner-two', 5), true);
    assert.equal(await data.unlockSave(first, 'same-document', 'owner-two'), 0);
    assert.equal(await data.unlockSave(first, 'same-document', 'owner-one'), 1);
    assert.equal(await data.unlockSave(second, 'same-document', 'owner-two'), 1);
  });

  test('cleaning a document removes its force-save timer as well as document data', async () => {
    const ctx = context('force-save-timer-cleanup');
    const docId = 'document';
    const dueLater = Date.now() + 60000;

    await data.addMessage(ctx, docId, {message: true});
    await data.addForceSaveTimerNX(ctx, docId, dueLater);
    await data.cleanDocumentOnExit(ctx, docId);

    assert.deepEqual(await data.getMessages(ctx, docId), []);
    const indexKeys = data._indexKeys(ctx, docId);
    assert.equal(await data._command(['ZSCORE', indexKeys.forceSaveTimer, documentMember(ctx, docId)]), null);
  });

  test('force-save transitions preserve opaque payloads and compare-and-set state', async () => {
    const ctx = context('force-save-payloads', {'services.CoAuthoring.expire.forcesave': 10});
    const docId = 'document';
    const changeInfo = {
      empty: [],
      nested: {empty: []},
      largeNumber: 123456789012345
    };
    const initialConvertInfo = {
      empty: [],
      nested: {empty: []},
      largeNumber: 123456789012345
    };

    await data.setForceSave(ctx, docId, 100, 5, 'https://example.test', changeInfo, initialConvertInfo);
    const key = data._docKeys(ctx, docId).forceSave;
    assert.ok((await data._command(['TTL', key])) > 0);

    const beforeStart = await data.getForceSave(ctx, docId);
    assert.deepEqual(beforeStart.changeInfo, changeInfo);
    assert.deepEqual(beforeStart.convertInfo, initialConvertInfo);
    assert.equal(beforeStart.started, false);
    assert.equal(beforeStart.ended, false);

    const started = await data.checkAndStartForceSave(ctx, docId);
    assert.deepEqual(started.changeInfo, changeInfo);
    assert.deepEqual(started.convertInfo, initialConvertInfo);
    assert.equal(started.started, true);
    assert.equal(started.ended, false);
    assert.ok((await data._command(['TTL', key])) > 0);
    assert.equal(await data.checkAndStartForceSave(ctx, docId), undefined);

    const stale = await data.checkAndSetForceSave(ctx, docId, 99, 5, false, true, {stale: true});
    assert.equal(stale, undefined);
    const afterStale = await data.getForceSave(ctx, docId);
    assert.deepEqual(afterStale.changeInfo, changeInfo);
    assert.deepEqual(afterStale.convertInfo, initialConvertInfo);
    assert.equal(afterStale.started, true);
    assert.equal(afterStale.ended, false);

    const endedConvertInfo = {empty: [], nested: {empty: []}, largeNumber: 123456789012345};
    const ended = await data.checkAndSetForceSave(ctx, docId, 100, 5, false, true, endedConvertInfo);
    assert.deepEqual(ended.changeInfo, changeInfo);
    assert.deepEqual(ended.convertInfo, endedConvertInfo);
    assert.equal(ended.started, false);
    assert.equal(ended.ended, true);
    assert.ok((await data._command(['TTL', key])) > 0);

    await data.checkAndSetForceSave(ctx, docId, 100, 5, false, false, null);
    const nullConvertInfo = await data.getForceSave(ctx, docId);
    assert.deepEqual(nullConvertInfo.changeInfo, changeInfo);
    assert.equal(nullConvertInfo.convertInfo, null);

    await data.checkAndSetForceSave(ctx, docId, 100, 5, false, false, undefined);
    const undefinedConvertInfo = await data.getForceSave(ctx, docId);
    assert.deepEqual(undefinedConvertInfo.changeInfo, changeInfo);
    assert.equal(undefinedConvertInfo.convertInfo, undefined);
    assert.equal(Object.hasOwn(undefinedConvertInfo, 'convertInfo'), true);

    const nullAndMissingDocId = 'null-and-missing';
    await data.setForceSave(ctx, nullAndMissingDocId, 101, 6, 'https://example.test', null, undefined);
    const nullAndMissing = await data.checkAndStartForceSave(ctx, nullAndMissingDocId);
    assert.equal(nullAndMissing.changeInfo, null);
    assert.equal(nullAndMissing.convertInfo, undefined);
    assert.equal(Object.hasOwn(nullAndMissing, 'changeInfo'), true);
    assert.equal(Object.hasOwn(nullAndMissing, 'convertInfo'), true);
  });

  test('resets an in-flight force-save after a failed conversion', async () => {
    const ctx = context('force-save-failed-conversion', {'services.CoAuthoring.expire.forcesave': 10});
    const docId = 'document';
    const failureInfo = {error: 'conversion failed'};

    await data.setForceSave(ctx, docId, 200, 8, 'https://example.test', {change: 'initial'}, null);
    assert.ok(await data.checkAndStartForceSave(ctx, docId));

    const failed = await data.checkAndSetForceSave(ctx, docId, 200, 8, false, false, failureInfo);
    assert.ok(failed, 'failed conversion state must be applied');
    assert.equal(failed.started, false);
    assert.equal(failed.ended, false);
    assert.deepEqual(failed.convertInfo, failureInfo);

    const retry = await data.checkAndStartForceSave(ctx, docId);
    assert.ok(retry, 'a failed force-save must be restartable');
    assert.equal(retry.started, true);
  });

  test('updating a unique user replaces its information without duplicating the user', async () => {
    const ctx = context('unique-user-update');
    // Expiry times are real UTC seconds: adding a user removes the ones that
    // expired by Redis server time.
    const now = Math.floor(Date.now() / 1000);

    await stat.addPresenceUniqueUser(ctx, 'user', now + 200000, {version: 1});
    await stat.addPresenceUniqueUser(ctx, 'user', now + 300000, {version: 2});

    assert.deepEqual(await stat.getPresenceUniqueUser(ctx, now + 100000), [{userid: 'user', expire: new Date((now + 300000) * 1000), version: 2}]);
  });

  test('unique users expire with their last user and expired users are removed when one is added', async () => {
    const ctx = context('unique-user-ttl');
    const keys = stat._uniqueKeys(ctx, false);
    const now = Math.floor(Date.now() / 1000);

    await stat.addPresenceUniqueUser(ctx, 'expired-user', now - 10, {});
    await stat.addPresenceUniqueUser(ctx, 'active-user', now + 100, {});

    // Removed without a read (/info) in between.
    assert.deepEqual(await stat._command(['ZRANGE', keys.expiry, '0', '-1']), ['active-user']);
    assert.equal(await stat._command(['HEXISTS', keys.info, 'expired-user']), 0);
    for (const key of [keys.expiry, keys.info]) {
      const ttl = Number(await stat._command(['PTTL', key]));
      assert.ok(ttl > 90000 && ttl <= 101000, `${key} TTL ${ttl}`);
    }
  });

  test('a failed documents index update after a presence write does not fail the write', async () => {
    const ctx = context('presence-index-failure');
    const info = JSON.stringify({id: 'user', connectionId: 'connection'});
    data._syncPresenceIndex = async () => {
      throw new Error('CLUSTERDOWN The cluster is down');
    };

    await data.addPresence(ctx, 'document', 'user', info);
    await data.updatePresence(ctx, 'document', 'user', info);
    assert.deepEqual(await data.getPresence(ctx, 'document'), [info]);

    await data.removePresence(ctx, 'document', 'user', 'connection').catch(() => {});
    delete data._syncPresenceIndex;
    await data.cleanDocumentOnExit(ctx, 'document');
  });

  test('presence keeps users apart whose ids differ only in a lone surrogate', async () => {
    const ctx = context('presence-surrogate');
    const first = JSON.stringify({id: 'user\ud800', connectionId: 'first'});
    const second = JSON.stringify({id: 'user\udc00', connectionId: 'second'});

    await data.addPresence(ctx, 'document', 'user\ud800', first);
    await data.addPresence(ctx, 'document', 'user\udc00', second);
    await data.removePresence(ctx, 'document', 'user\udc00', 'second');

    assert.deepEqual(await data.getPresence(ctx, 'document'), [first]);
    await data.removePresence(ctx, 'document', 'user\ud800', 'first');
    await data.cleanDocumentOnExit(ctx, 'document');
  });

  test('a renewed force-save claim is not claimed again by another instance', async () => {
    const tenant = `force-save-renewal-${Date.now()}`;
    const ctx = context(tenant);
    const other = new EditorData();
    try {
      data.expiredClaimLeaseMs = 300;
      other.expiredClaimLeaseMs = 300;
      await data.addForceSaveTimerNX(ctx, 'document', Date.now() - 1);
      const claimed = (await data.getForceSaveTimer(Date.now())).filter(item => item[0] === tenant);
      assert.deepEqual(claimed, [[tenant, 'document']]);

      for (let i = 0; i < 3; ++i) {
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(await data._renewForceSaveTimerExpired(claimed[0]), true);
      }
      // 450 ms after the claim: past the first lease, but it was renewed.
      const reclaimed = (await other.getForceSaveTimer(Date.now())).filter(item => item[0] === tenant);
      assert.deepEqual(reclaimed, []);
      assert.equal(await data._ackForceSaveTimer(claimed[0]), true);
      assert.equal(await data._renewForceSaveTimerExpired(claimed[0]), false);
    } finally {
      await other.close();
    }
  });

  test('licence statistics keep users apart whose ids differ only in a lone surrogate', async () => {
    const ctx = context(`unique-user-surrogate-${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);
    const ids = ['user\ud800', 'user\udc00', 'user\\"quoted"'];
    for (const id of ids) {
      await stat.addPresenceUniqueUser(ctx, id, now + 100, {});
      await stat.addPresenceUniqueUsersOfMonth(ctx, id, Date.UTC(2026, 0, 1), {id});
    }

    const users = (await stat.getPresenceUniqueUser(ctx, now)).map(user => user.userid).sort();
    assert.deepEqual(users, [...ids].sort());
    const month = await stat.getPresenceUniqueUsersOfMonth(ctx);
    assert.deepEqual(Object.keys(month['2026-01-01T00:00:00.000Z']).sort(), [...ids].sort());
  });

  test('a save or auth lock with an unusable tenant TTL uses the global TTL instead of failing', async () => {
    const ctx = context(`lock-ttl-fallback-${Date.now()}`);
    for (const [lock, name] of [
      ['lockSave', 'savelock'],
      ['lockAuth', 'lockdocument']
    ]) {
      assert.equal(await data[lock](ctx, 'document', 'user', 'abc'), true, lock);
      const ttl = Number(await data._command(['PTTL', `${data._docBase(ctx, 'document')}${name}`]));
      assert.ok(ttl > 0 && ttl <= 60000, `${lock} TTL ${ttl}`);
    }
    await data.unlockSave(ctx, 'document', 'user');
    await data.unlockAuth(ctx, 'document', 'user');
  });

  test('a notification with a repeat interval of a second or less is sent every time', async () => {
    const ctx = context(`notification-short-interval-${Date.now()}`);
    // notificationService passes floor(99% of repeatInterval / 1000): 0 for "1s".
    assert.equal(await stat.lockNotification(ctx, 'license', 0), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await stat.lockNotification(ctx, 'license', 0), true);
    assert.equal(await stat.lockNotification(ctx, 'license-hourly', 3564), true);
    assert.equal(await stat.lockNotification(ctx, 'license-hourly', 3564), false);
  });

  test('a closing instance sets its connection counts to 0', async () => {
    const ctx = context(`shard-counts-clear-${Date.now()}`);
    const counts = shardConnectionCounts.create('closing-instance');

    await counts.set(stat, ctx, 3, 2, 1);
    assert.equal(await stat.getEditorConnectionsCount(ctx, []), 3);
    assert.equal(await stat.getLiveViewerConnectionsCount(ctx, []), 2);
    assert.equal(await stat.getViewerConnectionsCount(ctx, []), 1);

    // Its connections reconnect to other instances, which count them again.
    await counts.clear(stat);
    assert.equal(await stat.getEditorConnectionsCount(ctx, []), 0);
    assert.equal(await stat.getLiveViewerConnectionsCount(ctx, []), 0);
    assert.equal(await stat.getViewerConnectionsCount(ctx, []), 0);
  });

  test('updating a monthly unique user keeps one entry for the period', async () => {
    const ctx = context('monthly-user-update');
    const period = Date.UTC(2026, 0, 1);

    await stat.addPresenceUniqueUsersOfMonth(ctx, 'user', period, {version: 1});
    await stat.addPresenceUniqueUsersOfMonth(ctx, 'user', period, {version: 2});

    assert.deepEqual(await stat.getPresenceUniqueUsersOfMonth(ctx), {
      '2026-01-01T00:00:00.000Z': {user: {version: 2}}
    });
  });

  test('editor connection statistics ignore malformed samples and retain valid data', async () => {
    stat._command = async () => ['not-json', JSON.stringify({notData: true}), JSON.stringify({data: {time: 100, edit: 1, liveview: 2, view: 3}})];

    assert.deepEqual(await stat.getEditorConnections(context('malformed-samples')), [{time: 100, edit: 1, liveview: 2, view: 3}]);
  });

  test('monthly statistics return an empty object when no periods are active', async () => {
    stat._command = async command => (command[0] === 'ZRANGEBYSCORE' ? [] : 0);

    assert.deepEqual(await stat.getPresenceUniqueUsersOfMonth(context('empty-month')), {});
  });
});

describe('removeLocks', () => {
  for (const [name, createStore] of [
    ['Redis', () => new EditorData()],
    ['in-memory', () => new MemoryEditorData()]
  ]) {
    test(`${name}: keeps a lock that another user holds by now`, async () => {
      const store = createStore();
      const ctx = context(`remove-locks-owner-${name}`);
      const docId = 'document';
      try {
        await store.addLocksNX(ctx, docId, {block: {time: 1, user: 'user-a', block: 'block'}});
        const userLocks = await store.getLocks(ctx, docId);
        // Before user A's removal arrives, another replica released the block
        // and granted it to user B.
        await store.removeAllLocks(ctx, docId);
        await store.addLocksNX(ctx, docId, {block: {time: 2, user: 'user-b', block: 'block'}});

        await store.removeLocks(ctx, docId, userLocks);

        assert.equal((await store.getLocks(ctx, docId)).block.user, 'user-b');
        await store.removeLocks(ctx, docId, {block: {time: 2, user: 'user-b', block: 'block'}});
        assert.equal(Object.keys(await store.getLocks(ctx, docId)).length, 0);
      } finally {
        await store.removeAllLocks(ctx, docId);
        await store.close();
      }
    });
  }
});
