'use strict';

// With the in-memory editor-data backend (the default), presence and shard
// counters do not expire on their own, so GC must accept any documentsCron, as
// main does. A long interval such as the AdminPanel placeholder
// '0 0 */2 * * *' must neither stop startup nor skip GC passes.
process.env.NODE_CONFIG = JSON.stringify({
  services: {CoAuthoring: {server: {editorDataStorage: 'editorDataMemory', editorStatStorage: ''}, expire: {documentsCron: '0 0 */2 * * *'}}}
});

const assert = require('node:assert/strict');
const {afterEach, describe, jest, test} = require('@jest/globals');

jest.mock('../../DocService/sources/DocsCoServer', () => ({
  editorData: {getDocumentPresenceExpired: jest.fn()}
}));
jest.mock('../../DocService/sources/taskresult', () => ({getExpired: jest.fn()}));
jest.mock('../../DocService/sources/canvasservice', () => ({cleanupCache: jest.fn()}));
jest.mock('../../Common/sources/taskqueueRabbitMQ', () => jest.fn());
jest.mock('../../Common/sources/operationContext', () => ({Context: jest.fn()}));
jest.mock('../../DocService/sources/pubsubRabbitMQ', () => jest.fn());
jest.mock('../../DocService/sources/databaseConnectors/baseConnector', () => ({}));

const docsCoServer = require('../../DocService/sources/DocsCoServer');
const operationContext = require('../../Common/sources/operationContext');
// Loading gc.js validates the base documentsCron; it must not throw here.
const {checkDocumentExpire} = require('../../DocService/sources/gc');

describe('document expiry GC with the in-memory backend', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('runs a pass with a documentsCron longer than the presence TTL', async () => {
    const ctx = {
      logger: {error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()},
      initTenantCache: jest.fn().mockResolvedValue(undefined),
      initDefault: jest.fn(),
      getCfg: jest.fn((_path, fallback) => fallback)
    };
    operationContext.Context.mockImplementation(() => ctx);
    docsCoServer.editorData.getDocumentPresenceExpired.mockResolvedValue([]);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    await checkDocumentExpire();

    assert.equal(ctx.logger.error.mock.calls.length, 0);
    assert.equal(docsCoServer.editorData.getDocumentPresenceExpired.mock.calls.length, 1);
    assert.equal(setTimeoutSpy.mock.calls.at(-1)[1], 7200000);
  });
});
