'use strict';

require('../env-setup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');

const mockSocketIo = {
  Server: class {
    constructor() {
      this.engine = {on() {}};
    }

    use() {}

    on() {}

    close() {
      return Promise.resolve();
    }
  }
};

jest.mock('socket.io', () => mockSocketIo, {virtual: true});
jest.mock(
  '../../DocService/sources/pubsubRabbitMQ',
  () =>
    class {
      on() {}

      init(callback) {
        callback();
      }
    }
);
jest.mock(
  '../../Common/sources/taskqueueRabbitMQ',
  () =>
    class {
      on() {}

      init(...args) {
        args.at(-1)();
      }
    }
);
jest.mock('../../DocService/sources/gc', () => ({
  getCronStep: () => 2147483647,
  startGC: jest.fn()
}));

const docsCoServer = require('../../DocService/sources/DocsCoServer');
const constants = require('../../Common/sources/constants');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function schemaColumns() {
  return [...new Set([...constants.TABLE_RESULT_SCHEMA, ...constants.TABLE_CHANGES_SCHEMA])].map(column_name => ({column_name}));
}

describe('DocsCoServer startup contract', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(sqlBase, 'getTableColumns').mockResolvedValue(schemaColumns());
  });

  afterEach(async () => {
    docsCoServer.cancelStartup();
    await docsCoServer.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('calls the callback once and only enables listening after both stores recover', async () => {
    let dataAttempts = 0;
    let statAttempts = 0;
    const callback = jest.fn();
    const server = {listen: jest.fn()};
    jest.spyOn(docsCoServer.editorData, 'connect').mockImplementation(async () => {
      dataAttempts++;
      if (dataAttempts === 1) {
        throw new Error('Redis unavailable');
      }
    });
    jest.spyOn(docsCoServer.editorStat, 'connect').mockImplementation(async () => {
      statAttempts++;
    });

    docsCoServer.install(server, {}, (...args) => {
      callback(...args);
      if (!args[0]) {
        server.listen();
      }
    });
    await flushPromises();
    assert.equal(callback.mock.calls.length, 0);
    assert.equal(server.listen.mock.calls.length, 0);

    await jest.advanceTimersByTimeAsync(1000);
    assert.equal(dataAttempts, 2);
    assert.equal(statAttempts, 1);
    assert.equal(callback.mock.calls.length, 1);
    assert.equal(callback.mock.calls[0][0], undefined);
    assert.equal(server.listen.mock.calls.length, 1);
  });

  test('calls the callback once with an error after startup retries are exhausted', async () => {
    const callback = jest.fn();
    const server = {listen: jest.fn()};
    jest.spyOn(docsCoServer.editorData, 'connect').mockRejectedValue(new Error('Redis unavailable'));
    jest.spyOn(docsCoServer.editorStat, 'connect').mockResolvedValue(undefined);

    docsCoServer.install(server, {}, callback);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);

    assert.equal(callback.mock.calls.length, 1);
    assert.match(callback.mock.calls[0][0].message, /Redis unavailable/);
    assert.equal(server.listen.mock.calls.length, 0);
  });

  test('fails startup when the database schema is incompatible', async () => {
    const callback = jest.fn();
    const server = {listen: jest.fn()};
    const connect = jest.spyOn(docsCoServer.editorData, 'connect').mockResolvedValue(undefined);
    sqlBase.getTableColumns.mockResolvedValue([]);

    docsCoServer.install(server, {}, callback);
    await flushPromises();

    assert.equal(callback.mock.calls.length, 1);
    assert.match(callback.mock.calls[0][0].message, /schema is incompatible/);
    assert.equal(connect.mock.calls.length, 0);
    assert.equal(server.listen.mock.calls.length, 0);
  });

  test('fails startup when the database schema query fails', async () => {
    const callback = jest.fn();
    const server = {listen: jest.fn()};
    const schemaError = new Error('database unavailable');
    const connect = jest.spyOn(docsCoServer.editorData, 'connect').mockResolvedValue(undefined);
    sqlBase.getTableColumns.mockRejectedValue(schemaError);

    docsCoServer.install(server, {}, callback);
    await flushPromises();

    assert.equal(callback.mock.calls.length, 1);
    assert.equal(callback.mock.calls[0][0], schemaError);
    assert.equal(connect.mock.calls.length, 0);
    assert.equal(server.listen.mock.calls.length, 0);
  });

  test('cancels a previous install when a new startup begins', async () => {
    jest.useRealTimers();
    const firstCallback = jest.fn();
    const secondCallback = jest.fn();
    const firstServer = {listen: jest.fn()};
    const secondServer = {listen: jest.fn()};
    jest.spyOn(docsCoServer.editorData, 'connect').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer.editorStat, 'connect').mockResolvedValue(undefined);

    docsCoServer.install(firstServer, {}, firstCallback);
    docsCoServer.install(secondServer, {}, secondCallback);
    await flushPromises();
    await flushPromises();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(firstCallback.mock.calls.length, 0);
    assert.equal(secondCallback.mock.calls.length, 1);
    assert.equal(secondCallback.mock.calls[0][0], undefined);
  });
});
