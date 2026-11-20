'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const {EDITOR_INDEX_QUEUES, editorIndexShard} = require('../../DocService/sources/editorDataRedis/redisKeys');
const {POP_EXPIRED_BATCH_SIZE, POP_EXPIRED_LEASE_MS} = require('../../DocService/sources/editorDataRedis/editorDataSettings');
const {EditorData} = require('../../DocService/sources/editorDataRedis');

jest.mock('../../DocService/sources/DocsCoServer', () => ({
  editorData: {
    getForceSaveTimer: jest.fn(),
    _ackForceSaveTimer: jest.fn(),
    getDocumentPresenceExpired: jest.fn(),
    _ackDocumentPresenceExpired: jest.fn()
  },
  startForceSave: jest.fn(),
  hasChanges: jest.fn(),
  cleanDocumentOnExitNoChangesPromise: jest.fn(),
  createSaveTimer: jest.fn()
}));
jest.mock('../../DocService/sources/taskresult', () => ({getExpired: jest.fn()}));
jest.mock('../../DocService/sources/canvasservice', () => ({cleanupCache: jest.fn()}));
jest.mock('../../Common/sources/operationContext', () => ({Context: jest.fn()}));
jest.mock('../../Common/sources/taskqueueRabbitMQ', () => jest.fn());
jest.mock('../../DocService/sources/pubsubRabbitMQ', () => jest.fn());
jest.mock('../../DocService/sources/databaseConnectors/baseConnector', () => ({}));

const docsCoServer = require('../../DocService/sources/DocsCoServer');
const operationContext = require('../../Common/sources/operationContext');
const queueService = require('../../Common/sources/taskqueueRabbitMQ');
const pubsubService = require('../../DocService/sources/pubsubRabbitMQ');
const {checkDocumentExpire, forceSaveTimeout} = require('../../DocService/sources/gc');

function context() {
  const ctx = {
    userId: 'redis-gc-worker',
    tenant: 'default',
    logger: {debug: jest.fn(), error: jest.fn(), info: jest.fn()},
    init: jest.fn((tenant, docId, userId) => {
      ctx.tenant = tenant;
      ctx.docId = docId;
      ctx.userId = userId;
    }),
    initTenantCache: jest.fn().mockResolvedValue(undefined),
    initDefault: jest.fn(),
    getCfg: jest.fn((_path, fallback) => fallback),
    setDocId: jest.fn(docId => {
      ctx.docId = docId;
    })
  };
  return ctx;
}

async function seedBacklog(data, queueName, tenant, count) {
  const ctx = {tenant};
  const targetShard = editorIndexShard(ctx, 'document-0');
  const indexKey = EDITOR_INDEX_QUEUES[queueName].index;
  let candidate = 0;
  let seeded = 0;

  while (seeded < count) {
    const docId = `document-${candidate++}`;
    if (editorIndexShard(ctx, docId) === targetShard) {
      await data._command(['ZADD', data._indexKeys(ctx, docId)[indexKey], '0', JSON.stringify([tenant, docId])]);
      seeded++;
    }
  }
}

describe('GC expiration continuation with Redis metadata', () => {
  let data;

  beforeEach(() => {
    data = new EditorData();
    jest.spyOn(data, '_ackDocumentPresenceExpired');
    operationContext.Context.mockImplementation(() => context());
    queueService.mockImplementation(() => ({
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    }));
    pubsubService.mockImplementation(() => ({
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    }));
    docsCoServer.editorData = data;
    docsCoServer.startForceSave.mockReset();
    docsCoServer.startForceSave.mockResolvedValue({code: commonDefines.c_oAscServerCommandErrors.NoError});
    docsCoServer.hasChanges.mockResolvedValue(false);
    docsCoServer.cleanDocumentOnExitNoChangesPromise.mockResolvedValue(undefined);
    docsCoServer.createSaveTimer.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await data.close();
  });

  test('schedules another GC pass from real shard continuation metadata', async () => {
    const tenant = `gc-real-metadata-${randomUUID()}`;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    await seedBacklog(data, 'forceSaveTimer', tenant, POP_EXPIRED_BATCH_SIZE + 1);

    await forceSaveTimeout();
    await forceSaveTimeout();

    // Only this tenant's items: other suites of the same run can leave entries
    // under the shared prefix that expire meanwhile.
    assert.equal(docsCoServer.startForceSave.mock.calls.filter(([itemCtx]) => itemCtx.tenant === tenant).length, POP_EXPIRED_BATCH_SIZE + 1);
    assert.deepEqual(
      (await data.getForceSaveTimer(Date.now())).filter(item => item[0] === tenant),
      []
    );
    const gcTimers = setTimeoutSpy.mock.calls.filter(([callback]) => callback === forceSaveTimeout);
    assert.equal(gcTimers.length, 2);
    assert.equal(gcTimers[0][1], 0);
    assert.equal(gcTimers[1][1], 60000);
  });

  test('renews a force-save claim while its force-save is still running', async () => {
    const tenant = `gc-force-save-renewal-${randomUUID()}`;
    jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const intervals = [];
    jest.spyOn(global, 'setInterval').mockImplementation((callback, delay) => {
      intervals.push({callback, delay});
      return {unref() {}};
    });
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const renew = jest.spyOn(data, '_renewForceSaveTimerExpired');
    let finish;
    docsCoServer.startForceSave.mockImplementation(itemCtx =>
      itemCtx.tenant === tenant
        ? new Promise(resolve => (finish = resolve))
        : Promise.resolve({code: commonDefines.c_oAscServerCommandErrors.NoError})
    );
    await seedBacklog(data, 'forceSaveTimer', tenant, 1);

    const pass = forceSaveTimeout();
    while (!finish) {
      await new Promise(resolve => setImmediate(resolve));
    }
    // The integrator callback can take longer than the claim lease.
    const renewal = intervals.find(interval => interval.delay === POP_EXPIRED_LEASE_MS / 3);
    assert.ok(renewal, 'a renewal timer runs while the force-save is processed');
    renewal.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(renew.mock.calls.length, 1);
    assert.equal(renew.mock.calls[0][0][0], tenant);
    assert.equal(await renew.mock.results[0].value, true);

    finish({code: commonDefines.c_oAscServerCommandErrors.NoError});
    await pass;
    assert.ok(clearIntervalSpy.mock.calls.length >= 1);
    assert.deepEqual(
      (await data.getForceSaveTimer(Date.now())).filter(item => item[0] === tenant),
      []
    );
  });

  test('schedules document-presence GC from real shard continuation metadata', async () => {
    const tenant = `gc-presence-real-metadata-${randomUUID()}`;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    await seedBacklog(data, 'documents', tenant, POP_EXPIRED_BATCH_SIZE + 1);

    await checkDocumentExpire();
    await checkDocumentExpire();

    // Only this tenant's items: other suites of the same run can leave presence
    // index entries under the shared prefix that expire meanwhile.
    assert.equal(data._ackDocumentPresenceExpired.mock.calls.filter(([item]) => item[0] === tenant).length, POP_EXPIRED_BATCH_SIZE + 1);
    assert.deepEqual(
      (await data.getDocumentPresenceExpired(Date.now())).filter(item => item[0] === tenant),
      []
    );
    const gcTimers = setTimeoutSpy.mock.calls.filter(([callback]) => callback === checkDocumentExpire);
    assert.equal(gcTimers.length, 2);
    assert.equal(gcTimers[0][1], 0);
    assert.equal(gcTimers[1][1], 120000);
  });
});
