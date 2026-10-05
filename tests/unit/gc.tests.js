'use strict';

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');
const commonDefines = require('../../Common/sources/commondefines');

jest.mock('../../DocService/sources/DocsCoServer', () => ({
  editorData: {
    _ackDocumentPresenceExpired: jest.fn(),
    getDocumentPresenceExpired: jest.fn(),
    _ackForceSaveTimer: jest.fn(),
    getForceSaveTimer: jest.fn()
  },
  hasChanges: jest.fn(),
  createSaveTimer: jest.fn(),
  cleanDocumentOnExitNoChangesPromise: jest.fn(),
  startForceSave: jest.fn()
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
const pubsubService = require('../../DocService/sources/pubsubRabbitMQ');
const {POP_EXPIRED_BATCH_SIZE, POP_EXPIRED_MAX_BATCH_SIZE} = require('../../DocService/sources/editorDataRedis/editorDataSettings');
const {checkDocumentExpire, forceSaveTimeout} = require('../../DocService/sources/gc');

function context() {
  const ctx = {
    userId: 'gc-worker',
    logger: {
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
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

function expiredBatch(items, hasMore) {
  Object.defineProperty(items, 'hasMore', {value: hasMore, enumerable: false});
  return items;
}

beforeEach(() => {
  docsCoServer.hasChanges.mockReset();
  docsCoServer.createSaveTimer.mockReset();
  docsCoServer.cleanDocumentOnExitNoChangesPromise.mockReset();
  docsCoServer.editorData.getDocumentPresenceExpired.mockReset();
  docsCoServer.editorData._ackDocumentPresenceExpired.mockReset();
  docsCoServer.editorData.getForceSaveTimer.mockReset();
  docsCoServer.editorData._ackForceSaveTimer.mockReset();
  docsCoServer.startForceSave.mockReset();
  docsCoServer.editorData._ackDocumentPresenceExpired.mockResolvedValue(true);
  docsCoServer.editorData._ackForceSaveTimer.mockResolvedValue(true);
  docsCoServer.createSaveTimer.mockResolvedValue(undefined);
  docsCoServer.cleanDocumentOnExitNoChangesPromise.mockResolvedValue(undefined);
  docsCoServer.startForceSave.mockResolvedValue({code: commonDefines.c_oAscServerCommandErrors.NoError});
  operationContext.Context.mockReset();
  queueService.mockReset();
  pubsubService.mockReset();
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

  test('schedules a bounded follow-up when document presence reaches the pass capacity', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const fullBatch = expiredBatch(
      Array.from({length: POP_EXPIRED_MAX_BATCH_SIZE}, (_, index) => ['tenant-a', `document-${index}`]),
      true
    );
    const remaining = [['tenant-a', 'document-after-capacity']];

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    docsCoServer.editorData.getDocumentPresenceExpired.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce(remaining);
    docsCoServer.hasChanges.mockResolvedValue(false);

    await checkDocumentExpire();
    await checkDocumentExpire();

    assert.equal(docsCoServer.editorData.getDocumentPresenceExpired.mock.calls.length, 2);
    assert.equal(docsCoServer.editorData._ackDocumentPresenceExpired.mock.calls.length, POP_EXPIRED_MAX_BATCH_SIZE + remaining.length);
    assert.equal(JSON.stringify(setTimeoutSpy.mock.calls.map(([, delay]) => delay)), JSON.stringify([0, 120000]));
  });

  test('schedules a follow-up when one shard reaches its per-shard capacity', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const skewedBatch = Array.from({length: POP_EXPIRED_BATCH_SIZE}, (_, index) => ['tenant-a', `skewed-document-${index}`]);
    Object.defineProperty(skewedBatch, 'hasMore', {value: true, enumerable: false});

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    docsCoServer.editorData.getDocumentPresenceExpired.mockResolvedValueOnce(skewedBatch).mockResolvedValueOnce([]);
    docsCoServer.hasChanges.mockResolvedValue(false);

    await checkDocumentExpire();
    await checkDocumentExpire();

    assert.equal(docsCoServer.editorData.getDocumentPresenceExpired.mock.calls.length, 2);
    assert.equal(JSON.stringify(setTimeoutSpy.mock.calls.map(([, delay]) => delay)), JSON.stringify([0, 120000]));
  });

  test('uses the normal interval after a shard failure instead of spinning', async () => {
    const ctx = context();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const failedBatch = expiredBatch([['tenant-a', 'document-from-healthy-shard']], true);
    Object.defineProperty(failedBatch, 'hasShardFailure', {value: true, enumerable: false});

    operationContext.Context.mockImplementation(() => ctx);
    docsCoServer.editorData.getDocumentPresenceExpired.mockResolvedValue(failedBatch);

    await checkDocumentExpire();

    assert.equal(setTimeoutSpy.mock.calls.at(-1)[1], 120000);
  });

  test('drains sustained auto-save force-save work across bounded follow-up passes', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const pubsub = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const fullBatch = expiredBatch(
      Array.from({length: POP_EXPIRED_MAX_BATCH_SIZE}, (_, index) => ['tenant-a', `auto-save-${index}`]),
      true
    );
    const finalBatch = [['tenant-a', 'auto-save-final']];
    const retryBatch = expiredBatch(
      fullBatch.map(([tenant, docId]) => [tenant, `${docId}-retry`]),
      true
    );

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    pubsubService.mockImplementation(() => pubsub);
    docsCoServer.editorData.getForceSaveTimer.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce(retryBatch).mockResolvedValueOnce(finalBatch);

    await forceSaveTimeout();
    await forceSaveTimeout();
    await forceSaveTimeout();

    assert.equal(docsCoServer.editorData.getForceSaveTimer.mock.calls.length, 3);
    assert.equal(docsCoServer.startForceSave.mock.calls.length, POP_EXPIRED_MAX_BATCH_SIZE * 2 + finalBatch.length);
    assert.equal(docsCoServer.editorData._ackForceSaveTimer.mock.calls.length, POP_EXPIRED_MAX_BATCH_SIZE * 2 + finalBatch.length);
    assert.equal(JSON.stringify(setTimeoutSpy.mock.calls.map(([, delay]) => delay)), JSON.stringify([0, 0, 60000]));
  });

  test('continues force-save expiration after one item fails and retries only that item', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const pubsub = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const failed = ['tenant-a', 'failed-auto-save'];
    const successful = ['tenant-a', 'successful-auto-save'];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    pubsubService.mockImplementation(() => pubsub);
    docsCoServer.editorData.getForceSaveTimer.mockResolvedValueOnce([failed, successful]).mockResolvedValueOnce([failed]);
    docsCoServer.startForceSave.mockImplementation(async (_ctx, docId) => {
      if (docId === failed[1]) {
        throw new Error('force-save retry');
      }
      return {code: commonDefines.c_oAscServerCommandErrors.NoError};
    });

    await forceSaveTimeout();
    await forceSaveTimeout();

    assert.equal(docsCoServer.startForceSave.mock.calls.length, 3);
    assert.equal(JSON.stringify(docsCoServer.editorData._ackForceSaveTimer.mock.calls.map(([item]) => item)), JSON.stringify([successful]));
    assert.equal(ctx.logger.error.mock.calls.length, 2);
    assert.equal(setTimeoutSpy.mock.calls.length, 2);
  });

  test('does not acknowledge a force-save that resolves with UnknownError and retries it', async () => {
    const ctx = context();
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const pubsub = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const failed = ['tenant-a', 'resolved-force-save-failure'];
    let attempts = 0;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    operationContext.Context.mockImplementation(() => ctx);
    queueService.mockImplementation(() => queue);
    pubsubService.mockImplementation(() => pubsub);
    docsCoServer.editorData.getForceSaveTimer.mockResolvedValueOnce([failed]).mockResolvedValueOnce([failed]);
    docsCoServer.startForceSave.mockImplementation(async () => {
      attempts++;
      return {
        code: attempts === 1 ? commonDefines.c_oAscServerCommandErrors.UnknownError : commonDefines.c_oAscServerCommandErrors.NoError
      };
    });

    await forceSaveTimeout();
    await forceSaveTimeout();

    assert.equal(attempts, 2);
    assert.equal(docsCoServer.editorData._ackForceSaveTimer.mock.calls.length, 1);
    assert.deepEqual(docsCoServer.editorData._ackForceSaveTimer.mock.calls[0][0], failed);
    assert.equal(ctx.logger.error.mock.calls.length, 1);
    assert.equal(setTimeoutSpy.mock.calls.length, 2);
  });

  test('continues with later force-save items when tenant initialization fails', async () => {
    const contexts = [];
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const pubsub = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const failed = ['tenant-a', 'failed-tenant-cache'];
    const successful = ['tenant-b', 'successful-after-cache-failure'];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    operationContext.Context.mockImplementation(() => {
      const ctx = context();
      if (contexts.length === 1) {
        ctx.initTenantCache.mockRejectedValueOnce(new Error('tenant configuration unavailable'));
      }
      contexts.push(ctx);
      return ctx;
    });
    queueService.mockImplementation(() => queue);
    pubsubService.mockImplementation(() => pubsub);
    docsCoServer.editorData.getForceSaveTimer.mockResolvedValue([failed, successful]);
    docsCoServer.startForceSave.mockResolvedValue({code: commonDefines.c_oAscServerCommandErrors.NoError});

    await forceSaveTimeout();

    assert.equal(docsCoServer.startForceSave.mock.calls.length, 1);
    assert.deepEqual(docsCoServer.startForceSave.mock.calls[0][1], successful[1]);
    assert.deepEqual(docsCoServer.editorData._ackForceSaveTimer.mock.calls[0][0], successful);
    assert.equal(contexts[1].logger.error.mock.calls.length, 1);
    assert.equal(setTimeoutSpy.mock.calls.length, 1);
  });

  test('keeps parallel force-save contexts isolated across delayed tenant operations', async () => {
    const rootCtx = context();
    const contexts = [rootCtx];
    const queue = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const pubsub = {
      initPromise: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    };
    const first = ['tenant-a', 'document-a'];
    const second = ['tenant-b', 'document-b'];
    let releaseFirstInit;
    let firstInitStarted;
    let releaseFirst;
    let firstStarted;
    let secondStarted;
    const firstInitGate = new Promise(resolve => {
      releaseFirstInit = resolve;
    });
    const firstInitStartedGate = new Promise(resolve => {
      firstInitStarted = resolve;
    });
    const firstGate = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const firstStartedGate = new Promise(resolve => {
      firstStarted = resolve;
    });
    const secondStartedGate = new Promise(resolve => {
      secondStarted = resolve;
    });
    const observations = [];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    operationContext.Context.mockImplementation(() => {
      const itemCtx = context();
      if (contexts.length === 2) {
        itemCtx.initTenantCache.mockImplementation(async () => {
          firstInitStarted();
          await firstInitGate;
        });
      }
      contexts.push(itemCtx);
      return itemCtx;
    });
    queueService.mockImplementation(() => queue);
    pubsubService.mockImplementation(() => pubsub);
    docsCoServer.editorData.getForceSaveTimer.mockResolvedValue([first, second]);
    docsCoServer.startForceSave.mockImplementation(async (itemCtx, docId) => {
      const tenantAtStart = itemCtx.tenant;
      if (docId === first[1]) {
        firstStarted();
        await firstGate;
      } else {
        secondStarted();
      }
      observations.push({docId, tenantAtStart, tenantAtCompletion: itemCtx.tenant});
      return {code: commonDefines.c_oAscServerCommandErrors.NoError};
    });

    const run = forceSaveTimeout();
    await firstInitStartedGate;
    await secondStartedGate;
    assert.equal(docsCoServer.startForceSave.mock.calls.length, 1);
    releaseFirstInit();
    await firstStartedGate;
    releaseFirst();
    await run;

    observations.sort((a, b) => a.docId.localeCompare(b.docId));
    assert.deepEqual(observations, [
      {docId: first[1], tenantAtStart: first[0], tenantAtCompletion: first[0]},
      {docId: second[1], tenantAtStart: second[0], tenantAtCompletion: second[0]}
    ]);
    assert.notEqual(contexts[2], contexts[3]);
    assert.equal(docsCoServer.editorData._ackForceSaveTimer.mock.calls.length, 2);
    assert.equal(setTimeoutSpy.mock.calls.length, 1);
  });
});
