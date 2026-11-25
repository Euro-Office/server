'use strict';

// With Redis editor data, a documentsCron slower than the presence and shard
// TTLs is shortened instead of rejected. The value may come from the
// AdminPanel's runtime.json, which is merged into the startup config, so
// throwing here would stop every DocService instead of just using a safe
// interval.
process.env.NODE_CONFIG = JSON.stringify({
  services: {CoAuthoring: {server: {editorDataStorage: 'editorDataRedis', editorStatStorage: ''}, expire: {documentsCron: '0 0 */2 * * *'}}}
});

const assert = require('node:assert/strict');
const {afterEach, describe, jest, test} = require('@jest/globals');

const mockGlobalLogger = {error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()};

jest.mock('../../DocService/sources/DocsCoServer', () => ({
  editorData: {getDocumentPresenceExpired: jest.fn()}
}));
jest.mock('../../DocService/sources/taskresult', () => ({getExpired: jest.fn()}));
jest.mock('../../DocService/sources/canvasservice', () => ({cleanupCache: jest.fn()}));
jest.mock('../../Common/sources/taskqueueRabbitMQ', () => jest.fn());
jest.mock('../../Common/sources/operationContext', () => ({Context: jest.fn(), global: {logger: mockGlobalLogger}}));
jest.mock('../../DocService/sources/pubsubRabbitMQ', () => jest.fn());
jest.mock('../../DocService/sources/databaseConnectors/baseConnector', () => ({}));

// Loading gc.js resolves the base documentsCron; it must not throw here.
const gc = require('../../DocService/sources/gc');

describe('document expiry GC with a slow documentsCron and Redis editor data', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('starts with the longest safe interval and logs the configuration error', () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    // 300 s TTLs: the default interval, also used by the presence and
    // statistics refresh in DocsCoServer.
    assert.equal(gc.getDocumentsExpireStep(), 120000);

    gc.startGC();

    assert.equal(setTimeoutSpy.mock.calls[0][1], 120000);
    assert.equal(mockGlobalLogger.error.mock.calls.length, 1);
    assert.match(mockGlobalLogger.error.mock.calls[0][1], /runs every 7200 seconds/);
    assert.match(mockGlobalLogger.error.mock.calls[0][1], /Using an interval of 120 seconds instead/);
  });
});
