'use strict';

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');

jest.mock('../../DocService/sources/DocsCoServer', () => ({
  editorData: {
    _ackDocumentPresenceExpired: jest.fn(),
    getDocumentPresenceExpired: jest.fn()
  },
  hasChanges: jest.fn(),
  createSaveTimer: jest.fn(),
  cleanDocumentOnExitNoChangesPromise: jest.fn()
}));
jest.mock('../../DocService/sources/taskresult', () => ({getExpired: jest.fn()}));
jest.mock('../../DocService/sources/canvasservice', () => ({cleanupCache: jest.fn()}));
jest.mock('../../Common/sources/taskqueueRabbitMQ', () => jest.fn());
jest.mock('../../Common/sources/operationContext', () => ({Context: jest.fn()}));
jest.mock('../../DocService/sources/pubsubRabbitMQ', () => jest.fn());
jest.mock('../../DocService/sources/databaseConnectors/baseConnector', () => ({}));

const docsCoServer = require('../../DocService/sources/DocsCoServer');
const operationContext = require('../../Common/sources/operationContext');
const queueService = require('../../Common/sources/taskqueueRabbitMQ');
const {checkDocumentExpire} = require('../../DocService/sources/gc');

function context() {
  const ctx = {
    userId: 'gc-worker',
    logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    },
    init: jest.fn((tenant, docId) => {
      ctx.tenant = tenant;
      ctx.docId = docId;
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

beforeEach(() => {
  docsCoServer.hasChanges.mockReset();
  docsCoServer.createSaveTimer.mockReset();
  docsCoServer.cleanDocumentOnExitNoChangesPromise.mockReset();
  docsCoServer.editorData.getDocumentPresenceExpired.mockReset();
  docsCoServer.editorData._ackDocumentPresenceExpired.mockReset();
  docsCoServer.editorData._ackDocumentPresenceExpired.mockResolvedValue(true);
  docsCoServer.createSaveTimer.mockResolvedValue(undefined);
  docsCoServer.cleanDocumentOnExitNoChangesPromise.mockResolvedValue(undefined);
  operationContext.Context.mockReset();
  queueService.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('document expiry GC', () => {
  test('checkDocumentExpire claims, processes, closes, and reschedules a valid batch', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const expiredKeys = [
      ['tenant-a', 'successful-document'],
      ['tenant-a', 'document-with-changes']
    ];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    docsCoServer.editorData.getDocumentPresenceExpired = jest.fn().mockResolvedValue(expiredKeys);
    docsCoServer.hasChanges.mockImplementation(async (_ctx, docId) => docId === 'document-with-changes');

    await checkDocumentExpire();

    assert.equal(ctx.initTenantCache.mock.calls.length, 2);
    assert.deepEqual(docsCoServer.editorData.getDocumentPresenceExpired.mock.calls.length, 1);
    assert.equal(JSON.stringify(queue.initPromise.mock.calls[0]), JSON.stringify([true, false, false, false, false, false]));
    assert.equal(queue.close.mock.calls.length, 1);
    assert.equal(docsCoServer.editorData._ackDocumentPresenceExpired.mock.calls.length, 2);
    assert.equal(docsCoServer.hasChanges.mock.calls.length, 2);
    assert.equal(docsCoServer.cleanDocumentOnExitNoChangesPromise.mock.calls.length, 1);
    assert.equal(docsCoServer.createSaveTimer.mock.calls.length, 1);
    assert.equal(ctx.initDefault.mock.calls.length, 1);
    assert.equal(setTimeoutSpy.mock.calls.at(-1)[1], 120000);
  });

  test('checkDocumentExpire rejects an unsafe runtime cron before claiming', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    ctx.getCfg.mockImplementation((path, fallback) => (path === 'services.CoAuthoring.expire.documentsCron' ? '0 */5 * * * *' : fallback));

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);

    await checkDocumentExpire();

    assert.equal(ctx.initTenantCache.mock.calls.length, 0);
    assert.equal(docsCoServer.editorData.getDocumentPresenceExpired.mock.calls.length, 0);
    assert.equal(queue.initPromise.mock.calls.length, 0);
    assert.equal(queue.close.mock.calls.length, 0);
    assert.match(ctx.logger.error.mock.calls[0][1], /must be shorter than both the presence and shard TTLs with scheduling headroom/);
    assert.equal(setTimeoutSpy.mock.calls.at(-1)[1], 120000);
  });

  test('continues a claimed batch after one document fails and acknowledges successful items', async () => {
    const ctx = context();
    const failed = ['tenant-a', 'permanently-failing-document'];
    const successful = [
      ['tenant-a', 'successful-document'],
      ['tenant-a', 'document-with-changes']
    ];
    const expiredKeys = [failed, ...successful];
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    docsCoServer.hasChanges.mockImplementation(async (_ctx, docId) => {
      if (docId === failed[1]) {
        throw new Error('permanent document failure');
      }
      return docId === 'document-with-changes';
    });

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    docsCoServer.editorData.getDocumentPresenceExpired.mockResolvedValue(expiredKeys);

    await checkDocumentExpire();

    const acknowledged = docsCoServer.editorData._ackDocumentPresenceExpired.mock.calls.map(([item]) => item);
    assert.equal(acknowledged.length, successful.length);
    assert.equal(acknowledged[0][1], successful[0][1]);
    assert.equal(acknowledged[1][1], successful[1][1]);
    assert.equal(ctx.logger.error.mock.calls.length, 1);
    assert.match(ctx.logger.error.mock.calls[0][2], /permanently-failing-document/);
    assert.match(ctx.logger.error.mock.calls[0][3], /permanent document failure/);
    assert.equal(queue.close.mock.calls.length, 1);
    assert.equal(setTimeoutSpy.mock.calls.at(-1)[1], 120000);
  });

  test('retries the failed item while avoiding reprocessing the already acknowledged items', async () => {
    const ctx = context();
    const failed = ['tenant-a', 'permanently-failing-document'];
    const successful = ['tenant-a', 'successful-document'];
    let attempts = 0;
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    docsCoServer.hasChanges.mockImplementation(async (_ctx, docId) => {
      if (docId === failed[1]) {
        attempts++;
        throw new Error('retryable permanent failure');
      }
      return false;
    });

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    docsCoServer.editorData.getDocumentPresenceExpired.mockResolvedValueOnce([failed, successful]).mockResolvedValueOnce([failed]);

    await checkDocumentExpire();
    await checkDocumentExpire();

    assert.equal(attempts, 2);
    assert.equal(docsCoServer.cleanDocumentOnExitNoChangesPromise.mock.calls.length, 1);
    assert.equal(docsCoServer.editorData._ackDocumentPresenceExpired.mock.calls.length, 1);
    assert.equal(docsCoServer.editorData._ackDocumentPresenceExpired.mock.calls[0][0][1], successful[1]);
    assert.equal(ctx.logger.error.mock.calls.length, 2);
    assert.equal(queue.close.mock.calls.length, 2);
    assert.equal(setTimeoutSpy.mock.calls.length, 2);
  });
});
