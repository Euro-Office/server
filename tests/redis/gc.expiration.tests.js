'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const {EDITOR_INDEX_QUEUES, editorIndexShard} = require('../../DocService/sources/editorDataRedis/redisKeys');
const {POP_EXPIRED_BATCH_SIZE} = require('../../DocService/sources/editorDataRedis/editorDataSettings');
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

    assert.equal(docsCoServer.startForceSave.mock.calls.length, POP_EXPIRED_BATCH_SIZE + 1);
    assert.deepEqual(await data.getForceSaveTimer(Date.now()), []);
    const gcTimers = setTimeoutSpy.mock.calls.filter(([callback]) => callback === forceSaveTimeout);
    assert.equal(gcTimers.length, 2);
    assert.equal(gcTimers[0][1], 0);
    assert.equal(gcTimers[1][1], 60000);
  });

  test('schedules document-presence GC from real shard continuation metadata', async () => {
    const tenant = `gc-presence-real-metadata-${randomUUID()}`;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    await seedBacklog(data, 'documents', tenant, POP_EXPIRED_BATCH_SIZE + 1);

    await checkDocumentExpire();
    await checkDocumentExpire();

    assert.equal(data._ackDocumentPresenceExpired.mock.calls.length, POP_EXPIRED_BATCH_SIZE + 1);
    assert.deepEqual(await data.getDocumentPresenceExpired(Date.now()), []);
    const gcTimers = setTimeoutSpy.mock.calls.filter(([callback]) => callback === checkDocumentExpire);
    assert.equal(gcTimers.length, 2);
    assert.equal(gcTimers[0][1], 0);
    assert.equal(gcTimers[1][1], 120000);
  });
});
