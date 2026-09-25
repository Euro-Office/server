'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, describe, test} = require('@jest/globals');

const {EditorStat} = require('../../DocService/sources/editorDataRedis');
const {ADD_MONTH_USER_SCRIPT, cfgExpMonthUniqueUsers, jsonEncode} = require('../../DocService/sources/editorDataRedis/base');
const {context, wait} = require('./testHelpers');

const stores = new Set();

function connectionKey(store, ctx) {
  return `${store._statBase(ctx)}editorconnections`;
}

function monthIndexKey(store, ctx, view = false) {
  return store._monthIndexKey(ctx, view);
}

function monthDataKey(store, ctx, period, view = false) {
  return store._monthDataKey(ctx, period, view);
}

async function pttl(store, key) {
  return Number(await store._command(['PTTL', key]));
}

async function addMonthUser(store, ctx, userId, period, duration, userInfo, expireAt = Date.now() + duration) {
  await store._eval(
    ADD_MONTH_USER_SCRIPT,
    [monthIndexKey(store, ctx), monthDataKey(store, ctx, period)],
    [String(expireAt), String(period), String(duration), String(userId), jsonEncode(userInfo)]
  );
}

async function waitForMissing(store, keys) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const exists = await Promise.all(keys.map(key => store._command(['EXISTS', key])));
    if (exists.every(value => Number(value) === 0)) {
      return;
    }
    await wait(20);
  }
  assert.fail(`Redis keys did not expire: ${keys.join(', ')}`);
}

afterEach(async () => {
  await Promise.all([...stores].map(store => store.close()));
  stores.clear();
});

describe('editorDataRedis stat key expiry', () => {
  test('gives editor connections and monthly index keys a positive TTL', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = context('stat-expiry-creation');
    const maxAge = 1000;
    const now = Date.now();
    const period = Date.UTC(2026, 0, 1);

    await store.setEditorConnections(ctx, 1, 2, 3, now, [{val: maxAge}]);
    await store.addPresenceUniqueUsersOfMonth(ctx, 'editor', period, {firstOpenDate: 'edit'});

    const connectionTtl = await pttl(store, connectionKey(store, ctx));
    const monthIndexTtl = await pttl(store, monthIndexKey(store, ctx));
    const monthDataTtl = await pttl(store, monthDataKey(store, ctx, period));
    assert.ok(connectionTtl > 0 && connectionTtl <= maxAge);
    assert.ok(monthIndexTtl > 0 && monthIndexTtl <= Number(cfgExpMonthUniqueUsers));
    assert.ok(monthDataTtl > 0 && monthDataTtl <= Number(cfgExpMonthUniqueUsers));
  });

  test('refreshes both index TTLs when a stat is written again', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = context('stat-expiry-refresh');
    const maxAge = 1000;
    const period = Date.UTC(2026, 1, 1);
    const connection = connectionKey(store, ctx);
    const monthIndex = monthIndexKey(store, ctx);

    await store.setEditorConnections(ctx, 1, 2, 3, Date.now(), [{val: maxAge}]);
    await store._command(['PEXPIRE', connection, '20']);
    await wait(5);
    await store.setEditorConnections(ctx, 4, 5, 6, Date.now(), [{val: maxAge}]);
    assert.ok((await pttl(store, connection)) > 100);

    await store.addPresenceUniqueUsersOfMonth(ctx, 'editor', period, {version: 1});
    await store._command(['PEXPIRE', monthIndex, '20']);
    await wait(5);
    await store.addPresenceUniqueUsersOfMonth(ctx, 'viewer', period, {version: 2});
    assert.ok((await pttl(store, monthIndex)) > 100);
  });

  test('removes both stat indexes after a short idle TTL', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = context('stat-expiry-idle');
    const connection = connectionKey(store, ctx);
    const monthIndex = monthIndexKey(store, ctx);
    const monthData = monthDataKey(store, ctx, Date.UTC(2026, 2, 1));

    await store.setEditorConnections(ctx, 1, 2, 3, Date.now(), [{val: 100}]);
    await addMonthUser(store, ctx, 'editor', Date.UTC(2026, 2, 1), 100, {version: 1});
    await waitForMissing(store, [connection, monthIndex, monthData]);
  });

  test('preserves pruning and returned statistics', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = context('stat-expiry-results');
    const maxAge = 1000;
    const now = Date.now();
    const period = Date.UTC(2026, 3, 1);

    await store.setEditorConnections(ctx, 1, 2, 3, now - maxAge, [{val: maxAge}]);
    await store.setEditorConnections(ctx, 4, 5, 6, now, [{val: maxAge}]);
    assert.deepEqual(await store.getEditorConnections(ctx), [{time: now, edit: 4, liveview: 5, view: 6}]);

    await store.addPresenceUniqueUsersOfMonth(ctx, 'editor', period, {firstOpenDate: 'edit'});
    await store.addPresenceUniqueViewUsersOfMonth(ctx, 'viewer', period, {firstOpenDate: 'view'});
    await addMonthUser(store, ctx, 'expired', period + 1, 1000, {expired: true}, Date.now() - 1);

    assert.deepEqual(await store.getPresenceUniqueUsersOfMonth(ctx), {
      '2026-04-01T00:00:00.000Z': {editor: {firstOpenDate: 'edit'}}
    });
    assert.deepEqual(await store.getPresenceUniqueViewUsersOfMonth(ctx), {
      '2026-04-01T00:00:00.000Z': {viewer: {firstOpenDate: 'view'}}
    });
  });
});
