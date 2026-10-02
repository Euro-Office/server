'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const net = require('node:net');
const {describe, test} = require('@jest/globals');
const redis = require('../../DocService/node_modules/redis');

const {
  RedisConnection,
  RedisUnavailableError,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS
} = require('../../DocService/sources/editorDataRedis/redisConnection');
const {
  RedisConnectionManager,
  redisConnectionManager,
  connectionScope,
  connectionGroups
} = require('../../DocService/sources/editorDataRedis/redisConnectionManager');
const {EditorCommon} = require('../../DocService/sources/editorDataRedis/editorCommon');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {
  normalizeNodeOptions,
  normalizeClusterOptions,
  normalizeSentinelOptions,
  sentinelReconnectStrategy
} = require('../../DocService/sources/editorDataRedis/redisConfig');

function fakeClient(properties = {}) {
  const client = new EventEmitter();
  Object.assign(client, {isOpen: true, isReady: true}, properties);
  return client;
}

describe('editorDataRedis connection contract', () => {
  test('closes each managed client once and rejects new leases after terminal shutdown', async () => {
    const clients = [];
    const manager = new RedisConnectionManager(() => {
      const client = {
        closeCalls: 0,
        async close() {
          this.closeCalls++;
        }
      };
      clients.push(client);
      return client;
    });
    const shared = manager.acquire(undefined, 'shared');
    const sharedAgain = manager.acquire(undefined, 'shared');
    const isolated = manager.acquire(undefined, 'isolated');

    assert.equal(shared, sharedAgain);
    assert.notEqual(shared, isolated);
    await manager.closeAll({terminal: true});
    assert.deepEqual(
      clients.map(client => client.closeCalls),
      [1, 1]
    );
    assert.equal(manager.owns(shared), false);
    assert.throws(
      () => manager.acquire(undefined, 'new'),
      error => error instanceof RedisUnavailableError
    );
  });

  test('waits for an in-flight command before closing the physical client', async () => {
    let resolveCommand;
    let commandStarted = false;
    let closeCalled = false;
    const connection = new RedisConnection();
    connection.client = fakeClient({
      sendCommand() {
        commandStarted = true;
        return new Promise(resolve => {
          resolveCommand = resolve;
        });
      },
      async close() {
        closeCalled = true;
        this.isOpen = false;
      }
    });
    connection.connector = 'redis';

    const command = connection.command(['PING']);
    while (!commandStarted) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const close = connection.close();
    await Promise.resolve();
    assert.equal(closeCalled, false);
    resolveCommand('PONG');
    assert.equal(await command, 'PONG');
    await close;
    assert.equal(closeCalled, true);
  });

  test('shares default connections and isolates logical databases', async () => {
    const first = new EditorCommon();
    const second = new EditorCommon();
    const proxy = new EditorCommon(7);

    try {
      assert.equal(first.redis, second.redis);
      assert.notEqual(first.redis, proxy.redis);
      assert.equal(redisConnectionManager.size(), 2);

      await first.close();
      assert.equal(redisConnectionManager.size(), 2);
      await assert.rejects(first.ping(), error => error instanceof RedisUnavailableError);
      await second.close();
      assert.equal(redisConnectionManager.size(), 1);
      await second.close();
    } finally {
      await proxy.close();
      await first.close();
      await second.close();
    }
    assert.equal(redisConnectionManager.size(), 0);
  });

  test('closed EditorCommon instances cannot reacquire a lease', async () => {
    const store = new EditorCommon();
    const connection = store.redis;

    await store.close();

    assert.equal(store.isConnected(), false);
    await assert.rejects(store.ping(), error => error instanceof RedisUnavailableError);
    assert.equal(redisConnectionManager.owns(connection), false);
  });

  test('shares the statistics client across stats, info, and notification stores', async () => {
    const notificationService = require('../../Common/sources/notificationService');
    assert.equal(redisConnectionManager.size(), 1);
    const infoRouter = require('../../DocService/sources/routes/info');
    const data = new EditorData();
    const stat = new EditorStat();

    try {
      assert.equal(connectionScope(), connectionScope(0));
      assert.notEqual(connectionScope(0, connectionGroups.editorData), connectionScope(0, connectionGroups.editorStat));
      assert.notEqual(data.redis, stat.redis);
      assert.equal(redisConnectionManager.size(), 2);
    } finally {
      await Promise.all([infoRouter.close(), notificationService.close(), data.close(), stat.close()]);
    }
    assert.equal(redisConnectionManager.size(), 0);
  });

  test('does not let a stale timeout abort a replacement client', async () => {
    let destroyed = false;
    const pending = [];
    const firstClient = fakeClient({
      sendCommand() {
        return new Promise(resolve => {
          pending.push(resolve);
        });
      },
      destroy() {
        destroyed = true;
        this.isOpen = false;
      }
    });
    const replacementClient = fakeClient({sendCommand: async () => 'PONG'});
    const connection = new RedisConnection();
    connection.client = firstClient;
    connection.connector = 'redis';
    connection.commandTimeoutMs = 10;
    connection._createClient = () => {
      connection.client = replacementClient;
      connection.connector = 'redis';
      connection.cluster = false;
      connection.sentinel = false;
    };

    const firstCommand = connection.command(['PING']);
    await new Promise(resolve => setImmediate(resolve));
    connection.commandTimeoutMs = 30;
    const staleCommand = connection.command(['PING']);
    await assert.rejects(firstCommand, error => error.code === 'ETIMEDOUT');
    assert.equal(destroyed, true);
    assert.equal(connection.client, null);

    assert.equal(await connection.command(['PING']), 'PONG');
    assert.equal(connection.client, replacementClient);

    await assert.rejects(staleCommand, error => error.code === 'ETIMEDOUT');
    assert.equal(connection.client, replacementClient);
    pending.forEach(resolve => resolve('late PONG'));
  });

  test('keeps a normal timeout local while concurrent commands fail and later commands reconnect', async () => {
    const pending = [];
    let destroyCalls = 0;
    const firstClient = fakeClient({
      sendCommand() {
        return new Promise(resolve => pending.push(resolve));
      },
      destroy() {
        destroyCalls++;
        this.isOpen = false;
      }
    });
    const replacementClient = fakeClient({sendCommand: async () => 'PONG'});
    const connection = new RedisConnection();
    connection.client = firstClient;
    connection.connector = 'redis';
    connection.commandTimeoutMs = 10;
    connection._createClient = () => {
      connection.client = replacementClient;
      connection.connector = 'redis';
      connection.cluster = false;
      connection.sentinel = false;
    };

    const unhandled = [];
    const onUnhandledRejection = reason => unhandled.push(reason);
    const initialExitCode = process.exitCode;
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const commands = [connection.command(['PING']), connection.command(['PING'])];
      await assert.rejects(commands[0], error => error.code === 'ETIMEDOUT');
      await assert.rejects(commands[1], error => error.code === 'ETIMEDOUT');
      assert.equal(destroyCalls, 1);
      assert.equal(await connection.command(['PING']), 'PONG');
      assert.equal(connection.client, replacementClient);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(process.exitCode, initialExitCode);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      pending.forEach(resolve => resolve('late PONG'));
    }
  });

  test('uses RESP2 for standalone node-redis clients', () => {
    assert.equal(normalizeNodeOptions({}, 0).RESP, 2);
    assert.equal(normalizeNodeOptions({}, 0).disableOfflineQueue, true);
  });

  test('applies the adapter timeout to node-redis command options', () => {
    assert.equal(normalizeNodeOptions({}, 0).commandOptions.timeout, 30000);
    assert.equal(normalizeNodeOptions({commandOptions: {timeout: 0}}, 0).commandOptions.timeout, 0);
  });

  test('reproduces node-redis 6.2.1 offline queuing before initial readiness', async () => {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const socket = {host: '127.0.0.1', port: server.address().port, reconnectStrategy: false, connectTimeout: 1000};
    const queuedClient = redis.createClient({socket});
    const failFastClient = redis.createClient({socket, disableOfflineQueue: true});
    queuedClient.on('error', () => {});
    failFastClient.on('error', () => {});
    const destroy = client => {
      try {
        client.destroy();
      } catch (_error) {
        // The client may already have been destroyed by its failed connection.
      }
    };

    try {
      const queuedConnect = queuedClient.connect().catch(() => undefined);
      const failFastConnect = failFastClient.connect().catch(() => undefined);
      await new Promise(resolve => setImmediate(resolve));

      const queuedCommand = queuedClient.sendCommand(['PING']);
      const queuedResult = await Promise.race([
        queuedCommand.then(
          () => 'settled',
          () => 'settled'
        ),
        new Promise(resolve => setTimeout(() => resolve('pending'), 25))
      ]);
      assert.equal(queuedResult, 'pending');
      await assert.rejects(failFastClient.sendCommand(['PING']), /offline/i);

      destroy(queuedClient);
      destroy(failFastClient);
      await queuedCommand.catch(() => undefined);
      await Promise.race([Promise.all([queuedConnect, failFastConnect]), new Promise(resolve => setTimeout(resolve, 100))]);
    } finally {
      destroy(queuedClient);
      destroy(failFastClient);
      sockets.forEach(socket => socket.destroy());
      await new Promise(resolve => server.close(resolve));
    }
  }, 10000);

  test('normalizes Cluster defaults without routing them to a standalone endpoint', () => {
    const options = normalizeClusterOptions({
      rootNodes: [{url: 'redis://cluster-node:7000'}],
      defaults: {password: 'secret'}
    });

    assert.deepEqual(options.rootNodes, [{url: 'redis://cluster-node:7000'}]);
    assert.deepEqual(options.defaults, {password: 'secret', socket: {connectTimeout: 15000}, disableOfflineQueue: true});
    assert.equal(options.commandOptions.timeout, 30000);
    assert.equal(options.RESP, 2);
  });

  test('normalizes native Sentinel options and applies the selected database to node clients', () => {
    const options = normalizeSentinelOptions(
      {
        name: 'mymaster',
        sentinelRootNodes: [{host: 'sentinel-a', port: '26379'}],
        nodeClientOptions: {user: 'redis-user', password: 'redis-password', socket: {tls: true}},
        sentinelClientOptions: {password: 'sentinel-password'}
      },
      2
    );

    assert.deepEqual(options.sentinelRootNodes, [{host: 'sentinel-a', port: 26379}]);
    assert.equal(options.RESP, 2);
    assert.equal(options.nodeClientOptions.username, 'redis-user');
    assert.equal(options.nodeClientOptions.password, 'redis-password');
    assert.equal(options.nodeClientOptions.database, 2);
    assert.equal(options.nodeClientOptions.RESP, 2);
    assert.equal(options.nodeClientOptions.socket.tls, true);
    assert.equal(options.sentinelClientOptions.password, 'sentinel-password');
    assert.equal(options.sentinelClientOptions.RESP, 2);
    assert.equal(options.commandOptions.timeout, 30000);
    assert.equal(options.nodeClientOptions.disableOfflineQueue, true);
    assert.equal(options.nodeClientOptions.commandsQueueMaxLength, REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH);
    assert.equal(options.nodeClientOptions.socket.reconnectStrategy, sentinelReconnectStrategy);
    assert.equal(options.sentinelClientOptions.disableOfflineQueue, true);
    assert.equal(options.sentinelClientOptions.commandsQueueMaxLength, REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH);
    assert.equal(options.sentinelClientOptions.socket.reconnectStrategy, false);
    assert.equal(options.reserveClient, true);
    assert.equal(options.maxCommandRediscovers, 0);
    assert.equal(REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS, 0);
    assert.equal(options.passthroughClientErrorEvents, true);
  });

  test('does not authenticate unauthenticated Sentinel or Redis nodes with empty credentials', () => {
    const options = normalizeSentinelOptions(
      {
        name: 'mymaster',
        sentinelRootNodes: [{host: 'sentinel-a', port: 26379}],
        nodeClientOptions: {username: 'default', password: ''},
        sentinelClientOptions: {username: 'default', password: ''}
      },
      0
    );

    assert.equal(options.nodeClientOptions.username, undefined);
    assert.equal(options.nodeClientOptions.password, undefined);
    assert.equal(options.sentinelClientOptions.username, undefined);
    assert.equal(options.sentinelClientOptions.password, undefined);
  });

  test('rejects usernames without passwords', () => {
    assert.throws(() => normalizeNodeOptions({username: 'redis-user'}), /authentication requires a password when a username is configured/);
    assert.throws(
      () =>
        normalizeSentinelOptions({
          name: 'mymaster',
          sentinelRootNodes: [{host: 'sentinel-a', port: 26379}],
          nodeClientOptions: {username: 'redis-user', password: 'redis-password'},
          sentinelClientOptions: {username: 'sentinel-user'}
        }),
      /authentication requires a password when a username is configured/
    );
  });

  test('uses bounded deterministic backoff for Sentinel node reconnects', () => {
    const cause = new Error('master unavailable');
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map(retries => sentinelReconnectStrategy(retries, cause)),
      [250, 500, 1000, 2000, 2000, false]
    );
  });

  test('rejects incomplete native Sentinel options', () => {
    assert.throws(() => normalizeSentinelOptions({name: 'mymaster'}), /sentinelRootNodes/);
  });

  test('rejects invalid or duplicate Sentinel root nodes', () => {
    assert.throws(
      () => normalizeSentinelOptions({name: 'mymaster', sentinelRootNodes: [{host: 'sentinel-a', port: 0}]}),
      /port must be an integer between 1 and 65535/
    );
    assert.throws(
      () =>
        normalizeSentinelOptions({
          name: 'mymaster',
          sentinelRootNodes: [
            {host: 'sentinel-a', port: 26379},
            {host: 'sentinel-a', port: '26379'}
          ]
        }),
      /must not contain duplicate nodes/
    );
    assert.throws(
      () => normalizeSentinelOptions({name: 'master name', sentinelRootNodes: [{host: 'sentinel-a', port: 26379}]}),
      /name to be a non-empty name without whitespace/
    );
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

  test('returns RedisUnavailableError when the client aborts after connect resolves', async () => {
    let commandCalls = 0;
    const connection = new RedisConnection();
    const client = fakeClient({
      sendCommand() {
        commandCalls++;
        return Promise.resolve('PONG');
      }
    });
    connection.client = client;
    connection.connector = 'redis';

    const connect = connection._connect.bind(connection);
    connection._connect = async () => {
      const connectedClient = await connect();
      connection._abortClient();
      return connectedClient;
    };

    await assert.rejects(connection.command(['PING']), error => {
      assert.ok(error instanceof RedisUnavailableError);
      assert.equal(error.code, 'REDIS_UNAVAILABLE');
      assert.equal(error instanceof TypeError, false);
      return true;
    });
    assert.equal(commandCalls, 0);
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

  test('rejects an initial Sentinel connection failure and clears the failed client', async () => {
    let attempts = 0;
    const connection = new RedisConnection();
    connection.connector = 'redis';
    connection.sentinel = true;
    connection._createClient = () => {
      attempts++;
      connection.client = fakeClient({
        isOpen: false,
        isReady: false,
        connect: async () => {
          throw new Error('Sentinel unavailable');
        }
      });
    };

    await assert.rejects(connection.connect(), /Sentinel unavailable/);
    assert.equal(attempts, REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES + 1);
    assert.equal(connection.client, null);
    assert.equal(connection.isConnected(), false);
  });

  test('retries transient initial Sentinel discovery with fresh clients', async () => {
    let attempts = 0;
    const clients = [];
    const connection = new RedisConnection();
    connection.sentinel = true;
    connection.connector = 'redis';
    connection._createClient = () => {
      attempts++;
      const client = fakeClient({
        isOpen: false,
        isReady: false,
        async connect() {
          if (attempts < 2) {
            throw new Error('Sentinel temporarily unavailable');
          }
          this.isOpen = true;
          this.isReady = true;
        },
        async close() {
          this.isOpen = false;
        }
      });
      clients.push(client);
      connection.client = client;
    };

    await connection.connect();

    assert.equal(attempts, 2);
    assert.equal(clients[0].isOpen, false);
    assert.equal(connection.client, clients[1]);
    assert.equal(connection.isConnected(), true);
    await connection.close();
  });

  test('does not retry initial Sentinel discovery after deliberate shutdown begins', async () => {
    let attempts = 0;
    const connection = new RedisConnection();
    connection.sentinel = true;
    connection.connector = 'redis';
    connection._createClient = () => {
      attempts++;
      const client = fakeClient({
        isOpen: false,
        isReady: false,
        connect: async () => {
          throw new Error('Sentinel temporarily unavailable');
        },
        close: async () => {
          client.isOpen = false;
        }
      });
      connection.client = client;
    };

    const connecting = connection.connect();
    while (attempts === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const closing = connection.close();

    await assert.rejects(connecting, error => error.code === 'REDIS_UNAVAILABLE');
    await closing;
    assert.equal(attempts, 1);
    assert.equal(connection.client, null);
  });

  test('fails fast for any topology while a client is reconnecting, then uses it after ready', async () => {
    let commandCalls = 0;
    const client = fakeClient({
      sendCommand: async () => {
        commandCalls++;
        return 'PONG';
      }
    });
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.sentinel = false;
    connection.connectionAttempted = true;

    client.isReady = false;
    await assert.rejects(connection.command(['PING']), error => {
      assert.ok(error instanceof RedisUnavailableError);
      assert.equal(error.code, 'REDIS_UNAVAILABLE');
      return true;
    });
    assert.equal(commandCalls, 0);

    client.isReady = true;
    assert.equal(await connection.command(['PING']), 'PONG');
    assert.equal(commandCalls, 1);
  });

  test('does not queue commands while a Sentinel client is disconnected', async () => {
    let commandCalls = 0;
    const client = fakeClient({
      sendCommand: async () => {
        commandCalls++;
        return 'unexpected';
      }
    });
    const connection = new RedisConnection();
    connection.client = client;
    connection.connector = 'redis';
    connection.sentinel = true;
    connection.connectionAttempted = true;
    client.isReady = false;

    await assert.rejects(connection.command(['SET', 'key', 'value']), error => error.code === 'REDIS_UNAVAILABLE');
    assert.equal(commandCalls, 0);
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

  test('recovers after a failed initial connection', async () => {
    let attempts = 0;
    const connection = new RedisConnection();
    connection._createClient = () => {
      attempts++;
      const client = fakeClient({isOpen: false, isReady: false});
      client.connect = async () => {
        if (attempts === 1) {
          throw new Error('connection refused');
        }
        client.isOpen = true;
        client.isReady = true;
      };
      connection.client = client;
      connection.connector = 'redis';
      connection.cluster = false;
      connection.sentinel = false;
    };

    await assert.rejects(connection.connect(), /connection refused/);
    assert.equal(connection.closed, false);
    await connection.connect();
    assert.equal(connection.isConnected(), true);
    assert.equal(attempts, 2);
    await connection.close();
  });

  test('propagates the final connection error after bounded reconnect exhaustion', async () => {
    const finalError = new Error('Sentinel retry limit reached');
    let attempts = 0;
    const connection = new RedisConnection();
    connection.connector = 'redis';
    connection.sentinel = true;
    connection._createClient = () => {
      attempts++;
      connection.client = fakeClient({
        isOpen: false,
        isReady: false,
        connect: async () => {
          throw finalError;
        }
      });
    };

    await assert.rejects(connection.connect(), error => error === finalError);
    assert.equal(attempts, REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES + 1);
    assert.equal(connection.client, null);
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

  test('stops a reconnecting client during shutdown', async () => {
    let closed = false;
    const client = fakeClient({
      close: async () => {
        closed = true;
        client.isOpen = false;
      }
    });
    const connection = new RedisConnection();
    connection.client = client;
    connection.connectionAttempted = true;

    await connection.close();
    assert.equal(closed, true);
    assert.equal(client.isOpen, false);
    assert.equal(connection.client, null);
  });

  test('deliberate shutdown permanently rejects future operations', async () => {
    const connection = new RedisConnection();
    connection.client = fakeClient({
      async close() {
        this.isOpen = false;
      }
    });

    await connection.close();
    await assert.rejects(connection.command(['PING']), error => {
      assert.ok(error instanceof RedisUnavailableError);
      return true;
    });
    assert.equal(connection.closed, true);
  });
});
