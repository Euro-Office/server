'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {describe, test} = require('@jest/globals');

const {RedisConnection} = require('../../DocService/sources/editorDataRedis/base');

function fakeClient(properties = {}) {
  const client = new EventEmitter();
  Object.assign(client, {isOpen: true, isReady: true}, properties);
  return client;
}

describe('editorDataRedis connection contract', () => {
  test('normalizes standalone command arguments before sending them', async () => {
    const calls = [];
    const connection = new RedisConnection();
    connection.client = fakeClient({
      sendCommand(args) {
        calls.push(args);
        return Promise.resolve('OK');
      }
    });
    connection.connector = 'redis';
    connection.cluster = false;

    assert.equal(await connection.command([Buffer.from('PING'), 42]), 'OK');
    assert.deepEqual(calls, [['PING', '42']]);
  });

  test('routes cluster commands by their first key and EVAL key', async () => {
    const calls = [];
    const connection = new RedisConnection();
    connection.client = fakeClient({
      sendCommand(...args) {
        calls.push(args);
        return Promise.resolve('OK');
      }
    });
    connection.connector = 'redis';
    connection.cluster = true;

    await connection.command(['SET', 'key', 'value']);
    await connection.command(['EVAL', 'return 1', '2', 'first-key', 'second-key']);
    await connection.command(['PING']);

    assert.deepEqual(calls, [
      ['key', false, ['SET', 'key', 'value']],
      ['first-key', false, ['EVAL', 'return 1', '2', 'first-key', 'second-key']],
      [undefined, false, ['PING']]
    ]);
  });

  test('executes standalone command batches transactionally', async () => {
    const added = [];
    const connection = new RedisConnection();
    connection.client = fakeClient({
      multi() {
        return {
          addCommand(args) {
            added.push(args);
          },
          exec: async () => ['OK', 1]
        };
      }
    });
    connection.connector = 'redis';
    connection.cluster = false;

    assert.deepEqual(await connection.commands([[Buffer.from('SET'), 'key', 'value'], ['GET', 'key']]), ['OK', 1]);
    assert.deepEqual(added, [['SET', 'key', 'value'], ['GET', 'key']]);
  });

  test('executes each command independently for Cluster batches', async () => {
    const calls = [];
    const connection = new RedisConnection();
    connection.client = fakeClient({
      sendCommand(...args) {
        calls.push(args);
        return Promise.resolve('OK');
      }
    });
    connection.connector = 'redis';
    connection.cluster = true;

    assert.deepEqual(await connection.commands([['SET', 'key-a', 'a'], ['SET', 'key-b', 'b']]), ['OK', 'OK']);
    assert.deepEqual(calls, [
      ['key-a', false, ['SET', 'key-a', 'a']],
      ['key-b', false, ['SET', 'key-b', 'b']]
    ]);
  });

  test('waits for readiness after a connection becomes open', async () => {
    const client = fakeClient({isOpen: false, isReady: false});
    client.connect = async () => {
      client.isOpen = true;
      setTimeout(() => {
        client.isReady = true;
        client.emit('ready');
      }, 1);
    };
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.cluster = false;

    await connection.connect();
    assert.equal(connection.isConnected(), true);
  });

  test('rejects when a connection ends before it becomes ready', async () => {
    const client = fakeClient({isOpen: false, isReady: false});
    client.connect = async () => {
      client.isOpen = true;
      setTimeout(() => client.emit('end'), 1);
    };
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.cluster = false;

    await assert.rejects(connection.connect(), /connection ended before becoming ready/);
    assert.equal(connection.client, null);
  });

  test('rejects when a connection emits a non-Error readiness failure', async () => {
    const client = fakeClient({isOpen: false, isReady: false});
    client.connect = async () => {
      client.isOpen = true;
      setTimeout(() => client.emit('error', 'connection failed'), 1);
    };
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.cluster = false;

    await assert.rejects(connection.connect(), /connection failed/);
    assert.equal(connection.client, null);
  });

  test('keeps a connected client after a non-timeout command failure', async () => {
    const client = fakeClient({
      sendCommand: async () => {
        throw new Error('command failed');
      }
    });
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.cluster = false;

    await assert.rejects(connection.command(['PING']), /command failed/);
    assert.equal(connection.client, client);
  });

  test('cleans up a failed connection attempt so a later attempt can create a client', async () => {
    const client = fakeClient({isOpen: false, isReady: false});
    client.connect = async () => {
      throw new Error('connection refused');
    };
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.cluster = false;

    await assert.rejects(connection.connect(), /connection refused/);
    assert.equal(connection.client, null);
    assert.equal(connection.isConnected(), false);
  });

  test('falls back to destroying a client when graceful close fails', async () => {
    let destroyed = false;
    const client = fakeClient({
      quit: async () => {
        throw new Error('quit failed');
      },
      destroy: () => {
        destroyed = true;
      }
    });
    const connection = new RedisConnection();
    connection.client = client;

    await connection.close();
    assert.equal(destroyed, true);
    assert.equal(connection.client, null);
  });
});
