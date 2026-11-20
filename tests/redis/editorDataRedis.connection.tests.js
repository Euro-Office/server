'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const net = require('node:net');
const {describe, test, jest} = require('@jest/globals');
const redis = require('../../DocService/node_modules/redis');
const {SimpleError, MultiErrorReply} = require('../../DocService/node_modules/@redis/client/dist/lib/errors');

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
  cfgRedisOptions,
  cfgRedisOptionsCluster,
  cfgRedisOptionsSentinel,
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
  test('distinguishes configured databases from explicit overrides in connection scopes', () => {
    assert.equal(connectionScope(), connectionScope(null));
    assert.equal(connectionScope(), connectionScope(''));
    assert.notEqual(connectionScope(), connectionScope(0));
    assert.equal(connectionScope(0), connectionScope('0'));
    assert.equal(connectionScope(5), connectionScope('5'));
  });

  test.each([
    ['standalone database', {database: '5'}, {}],
    ['standalone legacy db', {db: '5'}, {}],
    ['Sentinel fallback', {database: '5'}, {nodeClientOptions: {}}],
    ['Sentinel database', {database: 2}, {database: '5'}],
    ['Sentinel node database', {database: 2}, {nodeClientOptions: {database: '5'}}]
  ])('preserves the configured database for both editor stores with %s', async (_label, nodeOptions, sentinelOptions) => {
    const configs = [cfgRedisOptions, cfgRedisOptionsCluster, cfgRedisOptionsSentinel];
    const originals = configs.map(options => ({...options}));
    function replaceOptions(target, source) {
      Object.keys(target).forEach(key => delete target[key]);
      Object.assign(target, source);
    }
    const sentinel = Object.keys(sentinelOptions).length > 0;
    replaceOptions(cfgRedisOptions, nodeOptions);
    replaceOptions(cfgRedisOptionsCluster, {});
    replaceOptions(
      cfgRedisOptionsSentinel,
      sentinel
        ? {
            name: 'mymaster',
            sentinelRootNodes: [{host: '127.0.0.1', port: 26379}],
            ...sentinelOptions,
            nodeClientOptions: {...sentinelOptions.nodeClientOptions, socket: {tls: true}}
          }
        : {}
    );
    const createClient = jest.spyOn(redis, sentinel ? 'createSentinel' : 'createClient');
    // Acquire the explicit-zero lease first to catch cache collisions as well
    // as the database override passed to the client factory.
    const stores = [new EditorStat(0), new EditorData(), new EditorStat(), new EditorStat(7)];

    try {
      stores.forEach(store => store.redis._createClient());
      assert.deepEqual(
        Array.from(createClient.mock.calls, ([options]) => (sentinel ? options.nodeClientOptions.database : options.database)),
        [0, 5, 5, 7]
      );
      if (sentinel) {
        assert.ok(createClient.mock.calls.every(([options]) => options.nodeClientOptions.socket.tls));
      }
    } finally {
      await Promise.all(stores.map(store => store.close()));
      createClient.mockRestore();
      configs.forEach((options, index) => replaceOptions(options, originals[index]));
    }
  });

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
      assert.notEqual(connectionScope(), connectionScope(0));
      assert.notEqual(connectionScope(0, connectionGroups.editorData), connectionScope(0, connectionGroups.editorStat));
      assert.notEqual(data.redis, stat.redis);
      assert.equal(data.redis.serializeOperations, true);
      assert.equal(stat.redis.serializeOperations, false);
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
    // Fake clients only: in a Sentinel run, checking the configured Sentinels
    // would take longer than these short command timeouts.
    connection._probeSentinelRootNodes = async () => undefined;

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

  test('keeps a timed-out editor-data operation isolated while queued commands reconnect', async () => {
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
    const connection = new RedisConnection(undefined, {serializeOperations: true});
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
      assert.equal(destroyCalls, 1);
      assert.equal(await commands[1], 'PONG');
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

  test('passes timeouts to node-redis as numbers', () => {
    // node-redis gives these to timer APIs that throw for a string; with a
    // string command timeout the connect succeeds and every command fails.
    assert.equal(normalizeNodeOptions({commandOptions: {timeout: '5000'}}, 0).commandOptions.timeout, 5000);
    assert.equal(normalizeNodeOptions({socket: {connectTimeout: '2000'}}, 0).socket.connectTimeout, 2000);
    assert.equal(normalizeNodeOptions({commandOptions: {timeout: null}}, 0).commandOptions.timeout, null);
    for (const timeout of ['soon', '', -1, {}, true]) {
      assert.throws(() => normalizeNodeOptions({commandOptions: {timeout}}, 0), /commandOptions.timeout must be a non-negative number/);
    }
    assert.throws(() => normalizeNodeOptions({socket: {connectTimeout: '15s'}}, 0), /socket.connectTimeout must be a non-negative number/);
  });

  test('treats an empty username like no username', () => {
    for (const source of [
      {username: '', password: ''},
      {user: '', password: ''}
    ]) {
      const options = normalizeNodeOptions(source, 0);
      assert.equal(Object.hasOwn(options, 'username'), false);
      assert.equal(Object.hasOwn(options, 'password'), false);
    }
    assert.equal(normalizeNodeOptions({username: '', password: 'secret'}, 0).password, 'secret');
    assert.throws(() => normalizeNodeOptions({username: 'user', password: ''}, 0), /requires a password/);
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

  test('starts each new Sentinel client at the next root node', () => {
    // node-redis asks the root nodes in order; a dead first one must not block
    // every reconnect.
    const sentinel = {
      name: 'mymaster',
      sentinelRootNodes: [
        {host: 'sentinel-a', port: 26379},
        {host: 'sentinel-b', port: 26379},
        {host: 'sentinel-c', port: 26379}
      ]
    };
    const order = offset =>
      normalizeSentinelOptions(sentinel, 0, offset)
        .sentinelRootNodes.map(node => node.host)
        .join();

    assert.equal(order(undefined), 'sentinel-a,sentinel-b,sentinel-c');
    assert.equal(order(1), 'sentinel-b,sentinel-c,sentinel-a');
    assert.equal(order(2), 'sentinel-c,sentinel-a,sentinel-b');
    assert.equal(order(3), 'sentinel-a,sentinel-b,sentinel-c');
    assert.equal(sentinel.sentinelRootNodes[0].host, 'sentinel-a');
  });

  test('gives each Sentinel connection a share of the connect budget unless configured', () => {
    const rootNodes = count => Array.from({length: count}, (_, index) => ({host: `sentinel-${index}`, port: 26379}));
    const timeout = (count, sentinelClientOptions) =>
      normalizeSentinelOptions({name: 'mymaster', sentinelRootNodes: rootNodes(count), sentinelClientOptions}, 0).sentinelClientOptions.socket
        .connectTimeout;

    assert.equal(timeout(1), 7500);
    assert.equal(timeout(3), 3750);
    assert.equal(timeout(30), 1000);
    assert.equal(timeout(3, {socket: {connectTimeout: 9000}}), 9000);
    // The data node connection keeps the full budget.
    assert.equal(normalizeSentinelOptions({name: 'mymaster', sentinelRootNodes: rootNodes(3)}, 0).nodeClientOptions.socket.connectTimeout, 15000);
  });

  test('rotates the Sentinel root nodes for every client a connection creates', async () => {
    // Whatever topology this run uses, configure only Sentinel.
    const configured = {...cfgRedisOptionsSentinel};
    const configuredCluster = {...cfgRedisOptionsCluster};
    Object.keys(cfgRedisOptionsCluster).forEach(key => delete cfgRedisOptionsCluster[key]);
    Object.assign(cfgRedisOptionsSentinel, {
      name: 'mymaster',
      sentinelRootNodes: [
        {host: 'sentinel-a', port: 26379},
        {host: 'sentinel-b', port: 26379}
      ]
    });
    const createSentinel = jest.spyOn(redis, 'createSentinel');
    const connection = new RedisConnection();
    try {
      // Clients that are never connected.
      connection._createClient();
      connection._createClient();
      connection._createClient();

      assert.equal(createSentinel.mock.calls.map(([options]) => options.sentinelRootNodes[0].host).join(), 'sentinel-a,sentinel-b,sentinel-a');
    } finally {
      await connection.close();
      createSentinel.mockRestore();
      Object.keys(cfgRedisOptionsSentinel).forEach(key => delete cfgRedisOptionsSentinel[key]);
      Object.assign(cfgRedisOptionsSentinel, configured);
      Object.assign(cfgRedisOptionsCluster, configuredCluster);
    }
  });

  // Runs operation with only these Sentinel root nodes configured, whatever
  // topology this test run uses.
  async function withSentinelRootNodes(sentinelRootNodes, operation) {
    const configured = {...cfgRedisOptionsSentinel};
    const configuredCluster = {...cfgRedisOptionsCluster};
    Object.keys(cfgRedisOptionsCluster).forEach(key => delete cfgRedisOptionsCluster[key]);
    Object.keys(cfgRedisOptionsSentinel).forEach(key => delete cfgRedisOptionsSentinel[key]);
    Object.assign(cfgRedisOptionsSentinel, {name: 'mymaster', sentinelRootNodes});
    try {
      return await operation();
    } finally {
      Object.keys(cfgRedisOptionsSentinel).forEach(key => delete cfgRedisOptionsSentinel[key]);
      Object.assign(cfgRedisOptionsSentinel, configured);
      Object.assign(cfgRedisOptionsCluster, configuredCluster);
    }
  }

  async function listen(onSocket) {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      onSocket(socket);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      port: server.address().port,
      sockets,
      close: () => {
        sockets.forEach(socket => socket.destroy());
        return new Promise(resolve => server.close(resolve));
      }
    };
  }

  test('checks the Sentinels and leaves out one that accepts connections but never answers', async () => {
    // Reads but never answers (an unread socket would not report its close).
    const frozen = await listen(socket => socket.resume());
    // Answers every RESP command (the handshake and PING) with +PONG.
    const healthy = await listen(socket =>
      socket.on('data', data => {
        const commands = data
          .toString()
          .split('\r\n')
          .filter(line => line.startsWith('*')).length;
        socket.write('+PONG\r\n'.repeat(commands));
      })
    );
    const connection = new RedisConnection();
    try {
      const reachable = await withSentinelRootNodes(
        [
          {host: '127.0.0.1', port: frozen.port},
          {host: '127.0.0.1', port: healthy.port}
        ],
        () => connection._probeSentinelRootNodes(300)
      );

      assert.deepEqual([...reachable], [`127.0.0.1:${healthy.port}`]);
      // The check closes its own connections, also the one to the frozen Sentinel.
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(frozen.sockets.size, 0);
      assert.equal(healthy.sockets.size, 0);
    } finally {
      await connection.close();
      await Promise.all([frozen.close(), healthy.close()]);
    }
  });

  test('gives node-redis only the Sentinels that answered the check, or all when none did', async () => {
    const rootNodes = [
      {host: 'sentinel-a', port: 26379},
      {host: 'sentinel-b', port: 26379}
    ];
    const createSentinel = jest.spyOn(redis, 'createSentinel');
    const connection = new RedisConnection();
    try {
      await withSentinelRootNodes(rootNodes, async () => {
        // Clients that are never connected.
        connection._createClient({reachableSentinelRootNodes: new Set(['sentinel-b:26379'])});
        connection._createClient({reachableSentinelRootNodes: new Set()});
        connection._createClient();
      });
      const roots = createSentinel.mock.calls.map(([options]) => options.sentinelRootNodes.map(node => node.host).join('+'));
      assert.equal(roots.join(), 'sentinel-b,sentinel-b+sentinel-a,sentinel-a+sentinel-b');
    } finally {
      await connection.close();
      createSentinel.mockRestore();
    }
  });

  test('lets Sentinel node options override the shared credentials, also through the legacy user alias', () => {
    const shared = {username: cfgRedisOptions.username, password: cfgRedisOptions.password};
    cfgRedisOptions.username = 'shared-user';
    cfgRedisOptions.password = 'shared-password';
    try {
      const sentinel = {name: 'mymaster', sentinelRootNodes: [{host: 'sentinel-a', port: 26379}]};
      const aliased = normalizeSentinelOptions({...sentinel, nodeClientOptions: {user: 'node-user', password: 'node-password'}}, 0);
      assert.equal(aliased.nodeClientOptions.username, 'node-user');
      assert.equal(aliased.nodeClientOptions.password, 'node-password');
      assert.equal(Object.hasOwn(aliased.nodeClientOptions, 'user'), false);

      const inherited = normalizeSentinelOptions({...sentinel, nodeClientOptions: {}}, 0);
      assert.equal(inherited.nodeClientOptions.username, 'shared-user');
      assert.equal(inherited.nodeClientOptions.password, 'shared-password');
    } finally {
      for (const [key, value] of Object.entries(shared)) {
        if (value === undefined) {
          delete cfgRedisOptions[key];
        } else {
          cfgRedisOptions[key] = value;
        }
      }
    }
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

  test('starts the next Sentinel connect attempt before a stuck one uses up the connect budget', async () => {
    // node-redis has no timeout for a Sentinel that accepts the connection and
    // never answers; the first attempt is stuck behind such a Sentinel.
    const clients = [];
    const connection = new RedisConnection();
    connection.sentinel = true;
    connection.connector = 'redis';
    connection._createClient = () => {
      connection.sentinelRootNodeCount = 3;
      const stuck = clients.length === 0;
      const client = fakeClient({
        isOpen: false,
        isReady: false,
        connect() {
          this.isOpen = true;
          if (stuck) {
            return new Promise(() => {});
          }
          this.isReady = true;
          return Promise.resolve();
        },
        destroy() {
          this.isOpen = false;
        }
      });
      clients.push(client);
      connection.client = client;
    };

    const startedAt = Date.now();
    await connection.connect();
    const elapsed = Date.now() - startedAt;

    assert.equal(clients.length, 2);
    assert.equal(clients[0].isOpen, false);
    // Three Sentinels: each attempt gets a third of the 15 s budget.
    assert.ok(elapsed >= 4900 && elapsed < 7000, `connected after ${elapsed} ms`);
    await connection.close();
  }, 15000);

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

  test.each(
    ['Sentinel', 'standalone'].flatMap(topology =>
      [
        ['READONLY', 'command'],
        ['READONLY', 'transaction'],
        ['READONLY', 'transaction reply'],
        ['MASTERDOWN', 'command'],
        ['MASTERDOWN', 'transaction'],
        ['MASTERDOWN', 'transaction reply']
      ].map(([code, kind]) => [topology, code, kind])
    )
  )('invalidates a %s client on %s from a %s without replaying it', async (topology, code, kind) => {
    const sentinel = topology === 'Sentinel';
    const topologyError = new SimpleError(`${code} primary is unavailable`);
    const error = kind === 'transaction reply' ? new MultiErrorReply(['OK', topologyError], [1]) : topologyError;
    const failedOperation = jest.fn().mockRejectedValue(error);
    const destroy = jest.fn();
    const client = fakeClient({
      sendCommand: failedOperation,
      multi: () => ({addCommand() {}, exec: failedOperation}),
      destroy
    });
    const replacement = fakeClient({sendCommand: jest.fn().mockResolvedValue('OK'), close: async () => {}});
    const connection = new RedisConnection();
    connection.client = client;
    connection.sentinel = sentinel;
    connection._createClient = jest.fn(() => {
      connection.client = replacement;
      connection.clientGeneration++;
    });

    const commands = [['INCR', 'key']];
    await assert.rejects(kind === 'command' ? connection.command(commands[0]) : connection.commands(commands), caught => caught === error);
    assert.equal(connection.client, null);
    assert.equal(destroy.mock.calls.length, 1);
    assert.equal(failedOperation.mock.calls.length, 1);
    assert.equal(connection._createClient.mock.calls.length, 0);

    assert.equal(await connection.command(['SET', 'next-key', 'value']), 'OK');
    assert.equal(connection._createClient.mock.calls.length, 1);
    assert.deepEqual(
      Array.from(replacement.sendCommand.mock.calls, call => Array.from(call)),
      [sentinel ? [false, ['SET', 'next-key', 'value']] : [['SET', 'next-key', 'value']]]
    );
    assert.equal(failedOperation.mock.calls.length, 1);
    await connection.close();
  });

  test('keeps a Cluster client on READONLY, because the Cluster client follows redirects itself', async () => {
    const error = new SimpleError("READONLY You can't write against a read only replica.");
    const client = fakeClient({sendCommand: jest.fn().mockRejectedValue(error), destroy: jest.fn(), close: async () => {}});
    const connection = new RedisConnection();
    connection.client = client;
    connection.cluster = true;

    await assert.rejects(connection.command(['INCR', 'key']), caught => caught === error);
    assert.equal(connection.client, client);
    assert.equal(client.destroy.mock.calls.length, 0);
    await connection.close();
  });

  test('does not let a stale Sentinel topology error abort a replacement client', async () => {
    const pending = [];
    const client = fakeClient({
      sendCommand: () => new Promise((_resolve, reject) => pending.push(reject)),
      destroy: jest.fn()
    });
    const replacement = fakeClient({sendCommand: async () => 'OK', close: async () => {}});
    const connection = new RedisConnection();
    connection.client = client;
    connection.sentinel = true;
    connection._createClient = () => {
      connection.client = replacement;
      connection.clientGeneration++;
    };

    const first = assert.rejects(connection.command(['INCR', 'key']), /^Error: READONLY /);
    const stale = assert.rejects(connection.command(['INCR', 'key']), /^Error: READONLY /);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 2);
    pending[0](new SimpleError('READONLY old primary'));
    await first;
    assert.equal(await connection.command(['SET', 'next-key', 'value']), 'OK');

    pending[1](new SimpleError('READONLY old primary'));
    await stale;
    assert.equal(connection.client, replacement);
    assert.equal(client.destroy.mock.calls.length, 1);
    await connection.close();
  });

  test.each(
    ['Sentinel', 'standalone'].flatMap(topology =>
      [
        new SimpleError('WRONGTYPE Operation against a key holding the wrong kind of value'),
        new SimpleError('ERR script failed: READONLY'),
        new SimpleError('NOREPLICAS Not enough good replicas to write.'),
        new SimpleError('EXECABORT Transaction discarded because of previous errors.'),
        new MultiErrorReply([new SimpleError('WRONGTYPE invalid value'), 'READONLY user value'], [0]),
        new Error('Socket closed unexpectedly')
      ].map(error => [topology, error])
    )
  )('keeps the %s client after an ordinary failure: %s', async (topology, error) => {
    const client = fakeClient({sendCommand: jest.fn().mockRejectedValue(error), close: async () => {}});
    const connection = new RedisConnection();
    connection.client = client;
    connection.sentinel = topology === 'Sentinel';

    await assert.rejects(connection.command(['INCR', 'key']), caught => caught === error);
    assert.equal(connection.client, client);
    assert.equal(client.sendCommand.mock.calls.length, 1);
    await connection.close();
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

  // Like node-redis: close() stops accepting commands at once and waits for the
  // pending ones; destroy() throws once close() has started.
  function closingClient(properties) {
    const client = fakeClient({
      socketDestroyed: false,
      closeCalls: 0,
      close() {
        client.closeCalls++;
        client.isOpen = false;
        return new Promise(() => {});
      },
      destroy() {
        if (!client.isOpen) {
          throw new Error('The client is closed');
        }
        client.isOpen = false;
        client.socketDestroyed = true;
      },
      ...properties
    });
    return client;
  }

  test('destroys a client whose connect is still in flight instead of waiting for close', async () => {
    // For example a server that accepts the connection and never answers.
    const client = closingClient({isReady: false});
    const connection = new RedisConnection();
    connection.client = client;

    await connection.close();

    assert.equal(client.closeCalls, 0);
    assert.equal(client.socketDestroyed, true);
    assert.equal(connection.closed, true);
  });

  test('a graceful close that times out still completes the shutdown', async () => {
    const client = closingClient({isReady: true});
    const connection = new RedisConnection();
    connection.client = client;

    await connection.close();

    assert.equal(client.closeCalls, 1);
    assert.equal(connection.closed, true);
    assert.equal(connection.client, null);
  }, 15000);

  test('an aborted client whose destroy rejects does not raise an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const connection = new RedisConnection();
      connection.client = fakeClient({destroy: () => Promise.reject(new Error('sentinel destroy failed'))});

      connection._abortClient();
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(connection.client, null);
      assert.equal(unhandled.length, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('an editor store cancels its connection attempt for startup cancellation', async () => {
    const {connectRedisForStartup, StartupRedisCancelledError} = require('../../DocService/sources/startupRedis');
    const editorData = new EditorData();
    const editorStat = new EditorStat();
    const connection = editorData.redis;
    let aborted = 0;
    const abortClient = connection._abortClient;
    connection._abortClient = function (...args) {
      aborted++;
      this.connectPromise = null;
      return abortClient.apply(this, args);
    };
    // A connect attempt that only ends when it is cancelled.
    connection.connect = function () {
      this.connectPromise = new Promise(() => {});
      return this.connectPromise;
    };
    const controller = new AbortController();
    try {
      const startup = connectRedisForStartup({editorData, editorStat, signal: controller.signal, logger: {warn() {}}});
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();

      await assert.rejects(startup, error => error instanceof StartupRedisCancelledError);
      assert.equal(aborted, 1);
    } finally {
      delete connection.connect;
      connection._abortClient = abortClient;
      await Promise.all([editorData.close(), editorStat.close()]);
    }
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
