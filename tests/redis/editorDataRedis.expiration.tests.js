'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, describe, test} = require('@jest/globals');

const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {POP_EXPIRED_BATCH_SIZE, POP_EXPIRED_SCRIPT, strictMax, documentMember} = require('../../DocService/sources/editorDataRedis/base');

function context(tenant) {
  return {
    tenant,
    getCfg(_path, fallback) {
      return fallback;
    }
  };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

const queues = {
  presence: {
    add(data, ctx, docId) {
      return data._command(['ZADD', data.documentsKey, '0', documentMember(ctx, docId)]);
    },
    pop(data, now) {
      return data.getDocumentPresenceExpired(now);
    },
    acknowledge(data, item) {
      return data._ackDocumentPresenceExpired(item);
    },
    index(data) {
      return data.documentsKey;
    },
    lease(data) {
      return data.documentsExpiredLeaseKey;
    },
    claims(data) {
      return data.documentsExpiredClaimsKey;
    }
  },
  forceSave: {
    add(data, ctx, docId) {
      return data._command(['ZADD', data.forceSaveTimerKey, '0', documentMember(ctx, docId)]);
    },
    pop(data, now) {
      return data.getForceSaveTimer(now);
    },
    acknowledge(data, item) {
      return data._ackForceSaveTimer(item);
    },
    index(data) {
      return data.forceSaveTimerKey;
    },
    lease(data) {
      return data.forceSaveExpiredLeaseKey;
    },
    claims(data) {
      return data.forceSaveExpiredClaimsKey;
    }
  }
};

async function seed(data, queue, tenant, count) {
  const ctx = context(tenant);
  for (let index = 0; index < count; ++index) {
    await queue.add(data, ctx, `document-${index}`);
  }
}

async function discardPopResponse(data, queue, claimId = 'discarded-response') {
  const now = Date.now();
  await data._eval(
    POP_EXPIRED_SCRIPT,
    [queue.index(data), queue.lease(data), queue.claims(data)],
    [strictMax(now), String(now + data.expiredClaimLeaseMs), String(POP_EXPIRED_BATCH_SIZE), claimId]
  );
}

async function assertBatchLimit(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `expired-batch-${queueName}`;
  const count = POP_EXPIRED_BATCH_SIZE * 2 + 5;

  try {
    await seed(data, queue, tenant, count);

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

async function assertResponseDiscarded(queueName) {
  const data = new EditorData();
  const queue = queues[queueName];
  const tenant = `discarded-response-${queueName}`;
  data.expiredClaimLeaseMs = 30;

  try {
    await seed(data, queue, tenant, 1);
    // Redis has executed the claim, but the client deliberately discards the reply.
    await discardPopResponse(data, queue);
    await wait(60);

    const recovered = await queue.pop(data, Date.now());
    assert.deepEqual(recovered, [[tenant, 'document-0']]);
    assert.equal(await queue.acknowledge(data, recovered[0]), true);
    assert.deepEqual(await queue.pop(data, Date.now()), []);
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
    await assert.rejects(queue.pop(data, Date.now()), error => error.code === 'ETIMEDOUT');
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

  test('recovers a document-presence entry after a discarded response', () => assertResponseDiscarded('presence'));
  test('recovers a force-save entry after a discarded response', () => assertResponseDiscarded('forceSave'));

  test('does not let a stale document-presence acknowledgement remove a retry', () => assertRetryToken('presence'));
  test('does not let a stale force-save acknowledgement remove a retry', () => assertRetryToken('forceSave'));

  test('recovers only the unacknowledged document-presence item after a partial batch', () => assertPartialBatchRecovery('presence'));
  test('recovers only the unacknowledged force-save item after a partial batch', () => assertPartialBatchRecovery('forceSave'));

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
