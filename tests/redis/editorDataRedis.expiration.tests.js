'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, describe, jest, test} = require('@jest/globals');

const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {POP_EXPIRED_BATCH_SIZE, POP_EXPIRED_MAX_BATCH_SIZE} = require('../../DocService/sources/editorDataRedis/editorDataSettings');
const {POP_EXPIRED_SCRIPT} = require('../../DocService/sources/editorDataRedis/scripts');
const {strictMax} = require('../../DocService/sources/editorDataRedis/redisValueCodec');
const redisConnection = require('../../DocService/sources/editorDataRedis/redisConnection');
const {
  EDITOR_INDEX_QUEUES,
  EDITOR_INDEX_SHARD_COUNT,
  documentMember,
  editorIndexShard
} = require('../../DocService/sources/editorDataRedis/redisKeys');
const {context, wait} = require('./testHelpers');

function queueDefinition(name, pop, acknowledge) {
  const queue = EDITOR_INDEX_QUEUES[name];
  return {
    add(data, ctx, docId) {
      return data._command(['ZADD', data._indexKeys(ctx, docId)[queue.index], '0', documentMember(ctx, docId)]);
    },
    pop,
    acknowledge,
    index(data, ctx, docId) {
      return data._indexKeys(ctx, docId)[queue.index];
    },
    lease(data, ctx, docId) {
      return data._indexKeys(ctx, docId)[queue.lease];
    },
    claims(data, ctx, docId) {
      return data._indexKeys(ctx, docId)[queue.claims];
    }
  };
}

const queues = {
  presence: queueDefinition(
    'documents',
    (data, now) => data.getDocumentPresenceExpired(now),
    (data, item) => data._ackDocumentPresenceExpired(item)
  ),
  forceSave: queueDefinition(
    'forceSaveTimer',
    (data, now) => data.getForceSaveTimer(now),
    (data, item) => data._ackForceSaveTimer(item)
  )
};

async function seed(data, queue, tenant, count, sameShard = false) {
  const ctx = context(tenant);
  const targetShard = editorIndexShard(ctx, 'document-0');
  let candidate = 0;
  let seeded = 0;
  while (seeded < count) {
    const docId = `document-${candidate++}`;
    if (!sameShard || editorIndexShard(ctx, docId) === targetShard) {
      await queue.add(data, ctx, docId);
      seeded++;
    }
  }
}

async function discardPopResponse(data, queue, tenant, docId, claimId = 'discarded-response') {
  const ctx = context(tenant);
  const now = Date.now();
  const useRedisTime = queue === queues.presence;
  await data._eval(
    POP_EXPIRED_SCRIPT,
    [queue.index(data, ctx, docId), queue.lease(data, ctx, docId), queue.claims(data, ctx, docId)],
    useRedisTime
      ? ['', String(data.expiredClaimLeaseMs), String(POP_EXPIRED_BATCH_SIZE), claimId, 'redis-time']
      : [strictMax(now), String(now + data.expiredClaimLeaseMs), String(POP_EXPIRED_BATCH_SIZE), claimId, '']
  );
}

async function assertBatchLimit(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `expired-batch-${queueName}`;
  const count = POP_EXPIRED_BATCH_SIZE * 2 + 5;

  try {
    await seed(data, queue, tenant, count, true);

    const first = await queue.pop(data, Date.now());
    assert.equal(first.length, POP_EXPIRED_BATCH_SIZE);
    await Promise.all(first.map(item => queue.acknowledge(data, item)));

    const second = await queue.pop(data, Date.now());
    assert.equal(second.length, POP_EXPIRED_BATCH_SIZE);
    await Promise.all(second.map(item => queue.acknowledge(data, item)));

    const third = await queue.pop(data, Date.now());
    assert.equal(third.length, 5);
    await Promise.all(third.map(item => queue.acknowledge(data, item)));
    assert.deepEqual(await queue.pop(data, Date.now()), []);
  } finally {
    await data.close();
  }
}

async function assertSkewedBacklogContinuation(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `skewed-backlog-${queueName}`;
  const count = POP_EXPIRED_MAX_BATCH_SIZE + 4;
  let remaining = count;

  try {
    // Keep more than the aggregate 96-item limit in one shard. Each Redis pop
    // still returns at most the per-shard limit, so GC must use the metadata
    // rather than the flattened result length to schedule its next pass.
    await seed(data, queue, tenant, count, true);

    while (remaining > 0) {
      const batch = await queue.pop(data, Date.now());
      assert.ok(batch.length > 0);
      assert.ok(batch.length <= POP_EXPIRED_BATCH_SIZE);
      assert.equal(batch.hasMore, remaining > batch.length);
      await Promise.all(batch.map(item => queue.acknowledge(data, item)));
      remaining -= batch.length;
    }

    const empty = await queue.pop(data, Date.now());
    assert.deepEqual(empty, []);
    assert.equal(empty.hasMore, false);
  } finally {
    await data.close();
  }
}

async function assertShardFailurePreservesHealthyBatch(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `shard-failure-${queueName}`;
  const ctx = context(tenant);
  const failedShard = 0;
  const healthyShard = 1;
  const queueDefinition = EDITOR_INDEX_QUEUES[queueName === 'presence' ? 'documents' : 'forceSaveTimer'];
  const failedIndex = data._indexKeysForShard(failedShard)[queueDefinition.index];
  let healthyDocId;
  const logSpy = jest.spyOn(redisConnection, 'log');

  for (let candidate = 0; healthyDocId === undefined; ++candidate) {
    const docId = `document-${candidate}`;
    if (editorIndexShard(ctx, docId) === healthyShard) {
      healthyDocId = docId;
    }
  }

  try {
    await queue.add(data, ctx, healthyDocId);
    const popExpired = data._popExpired;
    data._popExpired = async function (indexKey, ...args) {
      if (indexKey === failedIndex) {
        throw new Error('simulated shard failure');
      }
      return popExpired.call(this, indexKey, ...args);
    };

    const batch = await queue.pop(data, Date.now());
    assert.deepEqual(batch, [[tenant, healthyDocId]]);
    assert.equal(batch.hasMore, true);
    assert.equal(batch.hasShardFailure, true);
    assert.deepEqual(batch.shardFailures, [{shard: failedShard, message: 'simulated shard failure', code: undefined}]);
    assert.ok(logSpy.mock.calls.some(call => call[0] === 'error' && call[1].includes('expired') && call[3] === failedShard));
    assert.equal(await queue.acknowledge(data, batch[0]), true);

    data._popExpired = popExpired;
    assert.deepEqual(await queue.pop(data, Date.now()), []);
  } finally {
    logSpy.mockRestore();
    await data.close();
  }
}

async function assertResponseDiscarded(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `discarded-response-${queueName}`;
  data.expiredClaimLeaseMs = 30;

  try {
    await seed(data, queue, tenant, 1);
    // Redis has executed the claim, but the client deliberately discards the reply.
    await discardPopResponse(data, queue, tenant, 'document-0');
    await wait(60);

    const recovered = await queue.pop(data, Date.now());
    assert.deepEqual(recovered, [[tenant, 'document-0']]);
    assert.equal(await queue.acknowledge(data, recovered[0]), true);
    assert.deepEqual(await queue.pop(data, Date.now()), []);
  } finally {
    await data.close();
  }
}

async function assertAllShards(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `all-shards-${queueName}`;
  const ctx = context(tenant);
  const documents = [];
  const shards = new Set();

  try {
    for (let candidate = 0; shards.size < EDITOR_INDEX_SHARD_COUNT; ++candidate) {
      const docId = `document-${candidate}`;
      const shard = editorIndexShard(ctx, docId);
      if (!shards.has(shard)) {
        shards.add(shard);
        documents.push(docId);
        await queue.add(data, ctx, docId);
      }
    }

    const expired = await queue.pop(data, Date.now());
    assert.deepEqual(new Set(expired.map(item => item[1])), new Set(documents), `${queueName} expiration did not process every shard`);
    await Promise.all(expired.map(item => queue.acknowledge(data, item)));
    assert.deepEqual(await queue.pop(data, Date.now()), []);
  } finally {
    await data.close();
  }
}

async function assertAggregateBatchLimit(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `aggregate-batch-${queueName}`;
  const ctx = context(tenant);
  const shardCounts = new Map();
  const documents = [];
  let fullShards = 0;

  try {
    for (let candidate = 0; fullShards < EDITOR_INDEX_SHARD_COUNT; ++candidate) {
      const docId = `document-${candidate}`;
      const shard = editorIndexShard(ctx, docId);
      const count = shardCounts.get(shard) || 0;
      if (count < POP_EXPIRED_BATCH_SIZE + 1) {
        const nextCount = count + 1;
        shardCounts.set(shard, nextCount);
        if (nextCount === POP_EXPIRED_BATCH_SIZE + 1) {
          fullShards++;
        }
        documents.push(docId);
        await queue.add(data, ctx, docId);
      }
    }

    const first = await queue.pop(data, Date.now());
    assert.equal(first.length, POP_EXPIRED_MAX_BATCH_SIZE);
    await Promise.all(first.map(item => queue.acknowledge(data, item)));

    const remaining = await queue.pop(data, Date.now());
    assert.equal(remaining.length, documents.length - first.length);
    await Promise.all(remaining.map(item => queue.acknowledge(data, item)));
  } finally {
    await data.close();
  }
}

async function assertRetryToken(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `retry-token-${queueName}`;
  data.expiredClaimLeaseMs = 30;

  try {
    await seed(data, queue, tenant, 1);
    const first = await queue.pop(data, Date.now());
    await wait(60);
    const retry = await queue.pop(data, Date.now());
    assert.deepEqual(retry, first);

    assert.equal(await queue.acknowledge(data, first[0]), false);
    assert.equal(await queue.acknowledge(data, retry[0]), true);
    assert.deepEqual(await queue.pop(data, Date.now()), []);
  } finally {
    await data.close();
  }
}

async function assertPartialBatchRecovery(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `partial-batch-${queueName}`;
  data.expiredClaimLeaseMs = 30;

  try {
    await seed(data, queue, tenant, 2);
    const claimed = await queue.pop(data, Date.now());
    assert.equal(claimed.length, 2);
    assert.equal(await queue.acknowledge(data, claimed[0]), true);

    // The worker completed only the first item before it crashed.  The second
    // item must be the only one recovered after the batch lease expires.
    await wait(60);
    const recovered = await queue.pop(data, Date.now());
    assert.deepEqual(recovered, [claimed[1]]);
    assert.equal(await queue.acknowledge(data, recovered[0]), true);
    assert.deepEqual(await queue.pop(data, Date.now()), []);
  } finally {
    await data.close();
  }
}

async function assertTimeoutAfterExecution(queueName) {
  const data = new EditorData();
  const retryData = new EditorData();
  const queue = queues[queueName];
  const tenant = `timeout-after-execution-${queueName}`;
  data.expiredClaimLeaseMs = 50;
  data.redis.commandTimeoutMs = 25;

  try {
    await seed(data, queue, tenant, 1);
    // Pause the server before sending POP_EXPIRED.  The command reaches Redis,
    // executes after the pause, and its reply arrives after the client timeout.
    await data._command(['CLIENT', 'PAUSE', '100', 'WRITE']);
    const claimed = await queue.pop(data, Date.now());
    assert.equal(claimed.hasShardFailure, true);
    await wait(150);

    retryData.expiredClaimLeaseMs = 50;
    const recovered = await queue.pop(retryData, Date.now());
    assert.deepEqual(recovered, [[tenant, 'document-0']]);
    assert.equal(await queue.acknowledge(retryData, recovered[0]), true);
  } finally {
    await Promise.all([data.close(), retryData.close()]);
  }
}

describe('editorDataRedis expiration claims', () => {
  afterEach(async () => {
    // Give a timed-out Redis client enough time to finish before the next test.
    await wait(20);
  });

  test('limits document-presence expiration batches', () => assertBatchLimit('presence'));
  test('limits force-save expiration batches', () => assertBatchLimit('forceSave'));
  test('continues a document-presence backlog concentrated in one shard', () => assertSkewedBacklogContinuation('presence'));
  test('continues a force-save backlog concentrated in one shard', () => assertSkewedBacklogContinuation('forceSave'));
  test('keeps healthy document-presence shards processing after one shard fails', () => assertShardFailurePreservesHealthyBatch('presence'));
  test('keeps healthy force-save shards processing after one shard fails', () => assertShardFailurePreservesHealthyBatch('forceSave'));
  test('bounds document-presence claims across all shards', () => assertAggregateBatchLimit('presence'));
  test('bounds force-save claims across all shards', () => assertAggregateBatchLimit('forceSave'));

  test('recovers a document-presence entry after a discarded response', () => assertResponseDiscarded('presence'));
  test('recovers a force-save entry after a discarded response', () => assertResponseDiscarded('forceSave'));

  test('does not let a stale document-presence acknowledgement remove a retry', () => assertRetryToken('presence'));
  test('does not let a stale force-save acknowledgement remove a retry', () => assertRetryToken('forceSave'));

  test('recovers only the unacknowledged document-presence item after a partial batch', () => assertPartialBatchRecovery('presence'));
  test('recovers only the unacknowledged force-save item after a partial batch', () => assertPartialBatchRecovery('forceSave'));

  test('processes document-presence expiration from every shard', () => assertAllShards('presence'));
  test('processes force-save timers from every shard', () => assertAllShards('forceSave'));

  test('recovers document-presence expiration after a client timeout', async () => {
    if (process.env.TEST_REDIS_CLUSTER === 'true') {
      return;
    }
    await assertTimeoutAfterExecution('presence');
  }, 10000);

  test('recovers force-save expiration after a client timeout', async () => {
    if (process.env.TEST_REDIS_CLUSTER === 'true') {
      return;
    }
    await assertTimeoutAfterExecution('forceSave');
  }, 10000);
});
