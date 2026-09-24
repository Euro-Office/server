'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {describe, test} = require('@jest/globals');

const {
  RedisConnection,
  normalizeNodeOptions,
  normalizeClusterOptions,
  normalizeSentinelOptions
} = require('../../DocService/sources/editorDataRedis/base');

function fakeClient(properties = {}) {
  const client = new EventEmitter();
  Object.assign(client, {isOpen: true, isReady: true}, properties);
  return client;
}

describe('editorDataRedis connection contract', () => {
  test('uses RESP2 for standalone node-redis clients', () => {
    assert.equal(normalizeNodeOptions({}, 0).RESP, 2);
  });

  test('applies the adapter timeout to node-redis command options', () => {
    assert.equal(normalizeNodeOptions({}, 0).commandOptions.timeout, 30000);
    assert.equal(normalizeNodeOptions({commandOptions: {timeout: 0}}, 0).commandOptions.timeout, 0);
  });

  test('normalizes Cluster defaults without routing them to a standalone endpoint', () => {
    const options = normalizeClusterOptions({
      rootNodes: [{url: 'redis://cluster-node:7000'}],
      defaults: {password: 'secret'}
    });

    assert.deepEqual(options.rootNodes, [{url: 'redis://cluster-node:7000'}]);
    assert.deepEqual(options.defaults, {password: 'secret', socket: {connectTimeout: 15000}});
    assert.equal(options.commandOptions.timeout, 30000);
    assert.equal(options.RESP, 2);
  });

  test('normalizes native Sentinel options and applies the selected database to node clients', () => {
    const options = normalizeSentinelOptions(
      {
        name: 'mymaster',
        sentinelRootNodes: [{host: 'sentinel-a', port: '26379'}],
        nodeClientOptions: {user: 'redis-user', socket: {tls: true}},
        sentinelClientOptions: {password: 'sentinel-password'}
      },
      2
    );

    assert.deepEqual(options.sentinelRootNodes, [{host: 'sentinel-a', port: 26379}]);
    assert.equal(options.RESP, 2);
    assert.equal(options.nodeClientOptions.username, 'redis-user');
    assert.equal(options.nodeClientOptions.database, 2);
    assert.equal(options.nodeClientOptions.RESP, 2);
    assert.equal(options.nodeClientOptions.socket.tls, true);
    assert.equal(options.sentinelClientOptions.password, 'sentinel-password');
    assert.equal(options.sentinelClientOptions.RESP, 2);
    assert.equal(options.commandOptions.timeout, 30000);
  });

  test('rejects incomplete native Sentinel options', () => {
    assert.throws(() => normalizeSentinelOptions({name: 'mymaster'}), /sentinelRootNodes/);
  });

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

  test('uses the native Sentinel raw-command signature', async () => {
    const calls = [];
    const connection = new RedisConnection();
    connection.client = fakeClient({
      sendCommand(...args) {
        calls.push(args);
        return Promise.resolve('PONG');
      }
    });
    connection.connector = 'redis';
    connection.sentinel = true;

    assert.equal(await connection.command(['PING']), 'PONG');
    assert.deepEqual(calls, [[false, ['PING']]]);
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

    assert.deepEqual(
      await connection.commands([
        [Buffer.from('SET'), 'key', 'value'],
        ['GET', 'key']
      ]),
      ['OK', 1]
    );
    assert.deepEqual(added, [
      ['SET', 'key', 'value'],
      ['GET', 'key']
    ]);
  });

  test('uses the native Sentinel batch-command signature', async () => {
    const added = [];
    const connection = new RedisConnection();
    connection.client = fakeClient({
      multi() {
        return {
          addCommand(...args) {
            added.push(args);
          },
          exec: async () => ['OK', 1]
        };
      }
    });
    connection.connector = 'redis';
    connection.sentinel = true;

    assert.deepEqual(
      await connection.commands([
        [Buffer.from('SET'), 'key', 'value'],
        ['GET', 'key']
      ]),
      ['OK', 1]
    );
    assert.deepEqual(added, [
      [false, ['SET', 'key', 'value']],
      [false, ['GET', 'key']]
    ]);
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

    assert.deepEqual(
      await connection.commands([
        ['SET', 'key-a', 'a'],
        ['SET', 'key-b', 'b']
      ]),
      ['OK', 'OK']
    );
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

  test('waits for Cluster readiness instead of treating an open client as ready', async () => {
    const client = fakeClient({isOpen: true, isReady: false});
    client.connect = async () => {};
    setTimeout(() => {
      client.isReady = true;
      client.emit('ready');
    }, 1);
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.cluster = true;

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
      close: async () => {
        throw new Error('close failed');
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

  test('uses close instead of the deprecated quit command', async () => {
    let closed = false;
    let quitCalled = false;
    const client = fakeClient({
      close: async () => {
        closed = true;
      },
      quit: async () => {
        quitCalled = true;
      }
    });
    const connection = new RedisConnection();
    connection.client = client;

    await connection.close();
    assert.equal(closed, true);
    assert.equal(quitCalled, false);
  });
});
