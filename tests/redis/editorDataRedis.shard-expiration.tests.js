'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, describe, test} = require('@jest/globals');

const {EditorStat} = require('../../DocService/sources/editorDataRedis');
const {cfgExpShard} = require('../../DocService/sources/editorDataRedis/editorStatSettings');
const {context} = require('./testHelpers');

const stores = new Set();

function shardContext(tenant, ttl) {
  return context(tenant, ttl === undefined ? {} : {'services.CoAuthoring.expire.shard': ttl});
}

async function ttl(store, key) {
  return Number(await store._command(['TTL', key]));
}

async function waitForExpired(store, keys) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const exists = await Promise.all(Object.values(keys).map(key => store._command(['EXISTS', key])));
    if (exists.every(value => Number(value) === 0)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('shard keys did not expire');
}

afterEach(async () => {
  await Promise.all([...stores].map(store => store.close()));
  stores.clear();
});

describe('editorDataRedis shard expiry', () => {
  test('applies the configured TTL to both keys for every connection shard type', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = shardContext('shard-expiry-all-types', 30);

    await store.setEditorConnectionsCountByShard(ctx, 'editor-a', 2);
    await store.setEditorConnectionsCountByShard(ctx, 'editor-b', 3);
    await store.setViewerConnectionsCountByShard(ctx, 'viewer-a', 4);
    await store.setLiveViewerConnectionsCountByShard(ctx, 'liveviewer-a', 5);

    for (const type of ['edit', 'view', 'liveview']) {
      const keys = store._shardKeys(ctx, type);
      assert.ok((await ttl(store, keys.count)) >= 29, `${type} count key was not given the shard TTL`);
      assert.ok((await ttl(store, keys.updated)) >= 29, `${type} updated key was not given the shard TTL`);
    }

    assert.equal(await store.getEditorConnectionsCount(ctx), 5);
  });

  test('refreshes both shard keys when another configured shard is incremented', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = shardContext('shard-expiry-refresh', 30);
    const keys = store._shardKeys(ctx, 'edit');

    await store.setEditorConnectionsCountByShard(ctx, 'old-shard', 2);
    await store._command(['EXPIRE', keys.count, '1']);
    await store._command(['EXPIRE', keys.updated, '1']);
    await store.incrEditorConnectionsCountByShard(ctx, 'new-shard', 3);

    assert.ok((await ttl(store, keys.count)) >= 29);
    assert.ok((await ttl(store, keys.updated)) >= 29);
    assert.equal(await store.getEditorConnectionsCount(ctx), 5);
  });

  test('does not refresh the shard TTL on read and removes stale shard fields', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = shardContext('shard-expiry-cleanup', 1);
    const keys = store._shardKeys(ctx, 'edit');

    await store.setEditorConnectionsCountByShard(ctx, 'stale-shard', 2);
    await store.setEditorConnectionsCountByShard(ctx, 'fresh-shard', 3);
    await store._command(['EXPIRE', keys.count, '30']);
    await store._command(['EXPIRE', keys.updated, '30']);
    await store._command(['ZADD', keys.updated, '0', 'stale-shard']);

    assert.equal(await store.getEditorConnectionsCount(ctx), 3);
    assert.equal(await store._command(['HEXISTS', keys.count, 'stale-shard']), 0);
    assert.equal(await store._command(['HEXISTS', keys.count, 'fresh-shard']), 1);
    assert.ok((await ttl(store, keys.count)) >= 29);
    assert.ok((await ttl(store, keys.updated)) >= 29);
  });

  test('keeps the existing single-shard default behavior', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = shardContext('shard-expiry-default');
    const keys = store._shardKeys(ctx, 'edit');

    await store.setEditorConnectionsCountByShard(ctx, 'default-shard', 1);

    assert.ok((await ttl(store, keys.count)) > 0);
    assert.ok((await ttl(store, keys.count)) <= Number(cfgExpShard));
    assert.ok((await ttl(store, keys.updated)) > 0);
    assert.ok((await ttl(store, keys.updated)) <= Number(cfgExpShard));
  });

  test('cleans both shard keys after explicit expiry', async () => {
    const store = new EditorStat();
    stores.add(store);
    const ctx = shardContext('shard-expiry-redis-cleanup', 1);
    const keys = store._shardKeys(ctx, 'edit');

    await store.setEditorConnectionsCountByShard(ctx, 'shard', 1);
    await store._command(['EXPIRE', keys.count, '1']);
    await store._command(['EXPIRE', keys.updated, '1']);
    await waitForExpired(store, keys);

    assert.equal(await store.getEditorConnectionsCount(ctx), 0);
    assert.equal(await store._command(['EXISTS', keys.count]), 0);
    assert.equal(await store._command(['EXISTS', keys.updated]), 0);
  });
});
