'use strict';

// documentsCron and filesCron can be changed in the AdminPanel, whose schema
// only checks for six fields, and its runtime.json is merged into the startup
// config. An expression that cannot be parsed must not stop DocService from
// starting, and one that fires once a year must not make a timer fire every
// millisecond (setTimeout runs longer delays after 1 ms).
process.env.NODE_CONFIG = JSON.stringify({
  services: {
    CoAuthoring: {
      server: {editorDataStorage: 'editorDataMemory', editorStatStorage: ''},
      expire: {documentsCron: 'x x x x x x', filesCron: '0 0 0 31 2 *'}
    }
  }
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

// Loading gc.js resolves both crons; it must not throw here.
const gc = require('../../DocService/sources/gc');
const {MAX_TIMER_DELAY_MS} = require('../../DocService/sources/expirationConfig');

describe('GC with crons from the AdminPanel that cannot be used as they are', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('starts with the default document interval and a capped files interval', () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    assert.equal(gc.getDocumentsExpireStep(), 120000);

    gc.startGC();

    const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay);
    assert.ok(delays.includes(120000), `timers ${delays}`);
    assert.ok(delays.includes(MAX_TIMER_DELAY_MS), `timers ${delays}`);
    const messages = mockGlobalLogger.error.mock.calls.map(([, message]) => message).join('\n');
    assert.match(messages, /Invalid services.CoAuthoring.expire.documentsCron/);
    assert.match(messages, /services.CoAuthoring.expire.filesCron runs every \d+ seconds, longer than a timer allows/);
  });

  test('the /info route loads with the same configuration', () => {
    assert.doesNotThrow(() => require('../../DocService/sources/routes/info'));
  });
});
