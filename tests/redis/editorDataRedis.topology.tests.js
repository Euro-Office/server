'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const net = require('node:net');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const redis = require('../../DocService/node_modules/redis');
const calculateClusterSlot = require('../../DocService/node_modules/cluster-key-slot');
const {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  RootNodesUnavailableError
} = require('../../DocService/node_modules/@redis/client/dist/lib/errors');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {createSentinelClient} = require('../../DocService/sources/editorDataRedis/redisConnection');
const redisTopologyConfig = require('../../DocService/sources/editorDataRedis/redisConfig');

const WAIT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;

function redisConfig() {
  return config.get('services.CoAuthoring.redis');
}

function configuredPassword(options) {
  return options.password || undefined;
}

function createDirectClient(port, password, host = '127.0.0.1') {
  const client = redis.createClient({
    socket: {host, port},
    ...(password === undefined ? {} : {password})
  });
  client.on('error', () => {});
  return client;
}

async function withDirectClient(port, password, operation, host) {
  const client = createDirectClient(port, password, host);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function waitFor(scenario, operation, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      lastValue = await operation();
      lastError = undefined;
      if (predicate(lastValue)) {
        return lastValue;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  assert.fail(`${scenario} timed out; last value: ${JSON.stringify(lastValue)}; last error: ${lastError?.message || 'none'}`);
}

function stopContainer(containerName) {
  assert.ok(containerName, 'failover tests require a container name');
  execFileSync('docker', ['stop', containerName], {stdio: 'pipe'});
}

function startContainer(containerName) {
  assert.ok(containerName, 'failover tests require a container name');
  execFileSync('docker', ['start', containerName], {stdio: 'pipe'});
}

function pauseContainer(containerName) {
  assert.ok(containerName, 'failover tests require a container name');
  execFileSync('docker', ['pause', containerName], {stdio: 'pipe'});
}

function unpauseContainer(containerName) {
  assert.ok(containerName, 'failover tests require a container name');
  execFileSync('docker', ['unpause', containerName], {stdio: 'pipe'});
}

async function waitForEditorDataCommand(data, command, expectedValue) {
  return waitFor(
    `editorDataRedis ${command[0]} after topology change`,
    () => data.redis.command(command),
    result => (expectedValue === undefined ? result !== undefined : result === expectedValue)
  );
}

function clusterNodeRecords(reply) {
  return String(reply)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const fields = line.split(' ');
      const endpoint = fields[1].split('@')[0];
      const [host, port] = endpoint.split(':');
      return {
        id: fields[0],
        host,
        port: Number(port),
        flags: fields[2].split(','),
        masterId: fields[3],
        slots: fields.slice(8)
      };
    });
}

function ownsSlot(node, slot) {
  return node.slots.some(range => {
    const [start, end = start] = range.split('-').map(Number);
    return slot >= start && slot <= end;
  });
}

async function clusterKeyOwner(rootHost, rootPort, password, key) {
  return withDirectClient(
    rootPort,
    password,
    async client => {
      const slot = calculateClusterSlot(key);
      const nodesReply = await client.sendCommand(['CLUSTER', 'NODES']);
      const nodes = clusterNodeRecords(nodesReply);
      const master = nodes.find(node => node.flags.includes('master') && ownsSlot(node, slot));
      assert.ok(master, `Cluster has no master for slot ${slot}`);
      const replica = nodes.find(node => node.masterId === master.id && (node.flags.includes('slave') || node.flags.includes('replica')));
      assert.ok(replica, `Cluster has no replica for slot ${slot}`);
      return {slot, master, replica};
    },
    rootHost
  );
}

async function keyOwnedByReplicaMaster(rootHost, rootPort, password, replicaPort, prefix) {
  return withDirectClient(
    rootPort,
    password,
    async client => {
      const nodes = clusterNodeRecords(await client.sendCommand(['CLUSTER', 'NODES']));
      const replica = nodes.find(node => node.port === replicaPort);
      assert.ok(replica, `Cluster has no replica on port ${replicaPort}`);
      const master = nodes.find(node => node.id === replica.masterId);
      assert.ok(master, `Cluster has no master for replica ${replicaPort}`);
      for (let attempt = 0; attempt < 10000; attempt++) {
        const key = `${prefix}${randomUUID()}`;
        if (ownsSlot(master, calculateClusterSlot(key))) {
          return key;
        }
      }
      assert.fail(`Could not find a key owned by Cluster master ${master.port}`);
    },
    rootHost
  );
}

async function waitForClusterPromotion(rootHost, rootPort, password, key, promotedPort) {
  const slot = calculateClusterSlot(key);
  return withDirectClient(
    rootPort,
    password,
    client =>
      waitFor(
        `Cluster replica ${promotedPort} promotion for ${key}`,
        async () => {
          const nodesReply = await client.sendCommand(['CLUSTER', 'NODES']);
          return clusterNodeRecords(nodesReply).find(node => node.port === promotedPort && node.flags.includes('master') && ownsSlot(node, slot));
        },
        Boolean
      ),
    rootHost
  );
}

async function waitForClientClusterPromotion(client, key, promotedPort) {
  const slot = calculateClusterSlot(key);
  return waitFor(
    `Redis client Cluster slot ${slot} promotion`,
    () => client.slots[slot]?.master?.port,
    port => Number(port) === promotedPort,
    30000
  );
}

async function promoteClusterReplica(replicaHost, replicaPort, password) {
  await withDirectClient(replicaPort, password, client => client.sendCommand(['CLUSTER', 'FAILOVER']), replicaHost);
}

async function waitForSentinelMaster(sentinelHost, sentinelPort, sentinelPassword, masterName, expectedHost, expectedPort) {
  return withDirectClient(
    sentinelPort,
    sentinelPassword,
    client =>
      waitFor(
        `Sentinel promotion to ${expectedPort}`,
        () => client.sendCommand(['SENTINEL', 'GET-MASTER-ADDR-BY-NAME', masterName]),
        reply =>
          Array.isArray(reply) && (expectedHost === undefined || String(reply[0]) === expectedHost) && String(reply[1]) === String(expectedPort)
      ),
    sentinelHost
  );
}

async function triggerSentinelFailover(sentinelHost, sentinelPort, sentinelPassword, masterName) {
  await withDirectClient(sentinelPort, sentinelPassword, client => client.sendCommand(['SENTINEL', 'FAILOVER', masterName]), sentinelHost);
}

async function createHeldSocketServer() {
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
  return {
    port: server.address().port,
    close: async () => {
      sockets.forEach(socket => socket.destroy());
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function assertRejectsWithin(promise, scenario, errorPredicate, timeoutMs = 2000) {
  const result = await Promise.race([
    promise.then(
      value => ({status: 'fulfilled', value}),
      error => ({status: 'rejected', error})
    ),
    new Promise(resolve => setTimeout(() => resolve({status: 'timeout'}), timeoutMs))
  ]);
  assert.notEqual(result.status, 'timeout', `${scenario} remained queued`);
  assert.equal(result.status, 'rejected', `${scenario} unexpectedly fulfilled`);
  assert.ok(errorPredicate(result.error), `${scenario} failed with unexpected error: ${result.error?.name}: ${result.error?.message}`);
  return result.error;
}

function waitForEvent(emitter, event, scenario, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = value => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`${scenario} did not emit ${event}`));
    }, timeoutMs);
    emitter.once(event, onEvent);
  });
}

function waitForAnyEvent(emitter, events, scenario, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => events.forEach(event => emitter.removeListener(event, onEvent));
    const onEvent = (value, event) => {
      clearTimeout(timer);
      cleanup();
      resolve({event, value});
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${scenario} did not emit any of: ${events.join(', ')}`));
    }, timeoutMs);
    events.forEach(event => emitter.once(event, value => onEvent(value, event)));
  });
}

function isOfflineOrTopologyError(error) {
  return error instanceof ClientOfflineError || error instanceof ClientClosedError || error instanceof RootNodesUnavailableError;
}

function isBoundedSentinelFailure(error) {
  return (
    error instanceof ConnectionTimeoutError ||
    isOfflineOrTopologyError(error) ||
    /timeout|unavailable|offline|closed|connection|master|sentinel/i.test(error?.message || '')
  );
}

async function waitForReconnectSignal(client, selectedTopology, nodePort) {
  if (selectedTopology === 'standalone') {
    return waitForEvent(client, 'reconnecting', 'standalone reconnect');
  }
  if (selectedTopology === 'cluster') {
    const node = [...client.nodeByAddress.values()].find(entry => entry.port === nodePort);
    assert.ok(node?.client, `Cluster node ${nodePort} is not connected`);
    return waitForEvent(node.client, 'reconnecting', `Cluster node ${nodePort} reconnect`, 30000);
  }
  return waitForAnyEvent(client, ['topology-change', 'client-error'], 'Sentinel rediscovery');
}

function clusterContainerForPort(port) {
  const index = Number(port) - 6999;
  assert.ok(Number.isInteger(index) && index >= 1 && index <= 6, `Unsupported Cluster node port ${port}`);
  return `eo-test-redis-cluster-${index}-compose`;
}

async function createUnreadyClient(probe) {
  const held = await createHeldSocketServer();
  const client = probe(held.port);
  client.on('error', () => {});
  const connect = client.connect().catch(() => undefined);
  await new Promise(resolve => setImmediate(resolve));
  return {
    client,
    connect,
    close: async () => {
      try {
        client.destroy();
      } catch (_error) {
        // The failed connection may already have destroyed the client.
      }
      await Promise.race([connect, new Promise(resolve => setTimeout(resolve, 100))]);
      await held.close();
    }
  };
}

const topology = process.env.TEST_REDIS_CLUSTER === 'true' ? 'cluster' : process.env.TEST_REDIS_SENTINEL === 'true' ? 'sentinel' : null;
const failoverConfigured =
  topology === 'cluster'
    ? Boolean(process.env.TEST_REDIS_CLUSTER_FAILOVER_REPLICA_PORT)
    : topology === 'sentinel'
      ? Boolean(process.env.TEST_REDIS_SENTINEL_PRIMARY_CONTAINER && process.env.TEST_REDIS_SENTINEL_REPLICA_PORT)
      : false;
if (process.env.TEST_REDIS_TOPOLOGY_REQUIRED === 'true' && !failoverConfigured) {
  throw new Error('Topology integration tests require a configured Cluster or Sentinel topology and its failover target; refusing to skip tests');
}
const describeClusterFailover = failoverConfigured && topology === 'cluster' ? describe : describe.skip;
const describeSentinelFailover = failoverConfigured && topology === 'sentinel' ? describe : describe.skip;

test('rejects commands issued before initial readiness for every configured topology', async () => {
  const configured = redisConfig();
  const clients = [];
  const selectedTopology = topology || 'standalone';
  try {
    if (selectedTopology === 'standalone') {
      clients.push(
        await createUnreadyClient(port => {
          const options = redisTopologyConfig.normalizeNodeOptions(configured.get('options') || {}, 0);
          options.socket = {host: '127.0.0.1', port, connectTimeout: 100};
          options.socket.reconnectStrategy = false;
          return redis.createClient(options);
        })
      );
      await assertRejectsWithin(
        clients[0].client.sendCommand(['PING']),
        'standalone pre-ready command',
        error => error instanceof ClientOfflineError
      );
    } else if (selectedTopology === 'cluster') {
      clients.push(
        await createUnreadyClient(port => {
          const options = redisTopologyConfig.normalizeClusterOptions(configured.get('optionsCluster') || {});
          options.rootNodes = [{url: `redis://127.0.0.1:${port}`}];
          options.defaults.socket = {...options.defaults.socket, connectTimeout: 100, reconnectStrategy: false};
          return redis.createCluster(options);
        })
      );
      await assertRejectsWithin(clients[0].client.sendCommand(undefined, false, ['PING']), 'Cluster pre-ready command', isOfflineOrTopologyError);
    } else {
      clients.push(
        await createUnreadyClient(port => {
          const options = redisTopologyConfig.normalizeSentinelOptions(configured.get('optionsSentinel') || {}, 0);
          options.sentinelRootNodes = [{host: '127.0.0.1', port}];
          options.nodeClientOptions.socket = {...options.nodeClientOptions.socket, connectTimeout: 100, reconnectStrategy: false};
          options.sentinelClientOptions.socket = {...options.sentinelClientOptions.socket, connectTimeout: 100, reconnectStrategy: false};
          return createSentinelClient(options);
        })
      );
      await assertRejectsWithin(clients[0].client.sendCommand(false, ['PING']), 'Sentinel pre-ready command', isBoundedSentinelFailure);
      await assertRejectsWithin(clients[0].client.ping(), 'Sentinel pre-ready generated command', isBoundedSentinelFailure);
    }
  } finally {
    await Promise.all(clients.map(entry => entry.close()));
  }
}, 30000);

test('uses independent editor-data and editor-stat clients on the configured topology', async () => {
  const data = new EditorData();
  const stat = new EditorStat();
  const timeoutKey = `${process.env.TEST_REDIS_PREFIX}timeout:${randomUUID()}`;

  try {
    assert.notEqual(data.redis, stat.redis);
    await Promise.all([data.connect(), stat.connect()]);
    const [dataPing, statPing] = await Promise.all([data.ping(), stat.ping()]);
    assert.equal(dataPing, 'PONG');
    assert.equal(statPing, 'PONG');

    data.redis.commandTimeoutMs = 100;
    await assert.rejects(data.redis.command(['BLPOP', timeoutKey, '5']), error => error.code === 'ETIMEDOUT');
    const [dataAfterTimeout, statAfterTimeout] = await Promise.all([data.ping(), stat.ping()]);
    assert.equal(dataAfterTimeout, 'PONG');
    assert.equal(statAfterTimeout, 'PONG');
  } finally {
    await Promise.all([data.close(), stat.close()]);
  }
}, 30000);

describeClusterFailover('editorDataRedis Cluster failover integration', () => {
  test('promotes a Cluster replica and reconnects the existing editorData client', async () => {
    const options = redisTopologyConfig.normalizeClusterOptions(redisConfig().get('optionsCluster') || {});
    const root = new URL(options.rootNodes[0].url);
    const rootHost = root.hostname;
    const rootPort = Number(root.port);
    const promotedPort = Number(process.env.TEST_REDIS_CLUSTER_FAILOVER_REPLICA_PORT);
    const data = new EditorData();
    const stat = new EditorStat();
    let key;
    let primaryStopped = false;
    let primaryContainer;

    try {
      await data.connect();
      await stat.connect();
      key = await keyOwnedByReplicaMaster(
        rootHost,
        rootPort,
        configuredPassword(options.defaults),
        promotedPort,
        `${process.env.TEST_REDIS_PREFIX}cluster-failover:`
      );
      assert.equal(await data.redis.command(['SET', key, 'before-failover']), 'OK');
      const ownership = await clusterKeyOwner(rootHost, rootPort, configuredPassword(options.defaults), key);
      assert.equal(
        promotedPort,
        ownership.replica.port,
        `Configured failover replica ${promotedPort} does not replicate the key owner ${ownership.master.port}`
      );
      primaryContainer = clusterContainerForPort(ownership.master.port);
      const reconnecting = waitForReconnectSignal(data.redis.client, 'cluster', ownership.master.port);
      await promoteClusterReplica(ownership.replica.host, promotedPort, configuredPassword(options.defaults));
      await waitForClusterPromotion(ownership.replica.host, promotedPort, configuredPassword(options.defaults), key, promotedPort);
      stopContainer(primaryContainer);
      primaryStopped = true;
      await reconnecting;
      const duringFailover = await Promise.race([
        Promise.allSettled([data.ping(), stat.ping(), data.redis.command(['GET', key]), stat.redis.command(['PING'])]),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
      ]);
      assert.notEqual(duringFailover, 'timeout', 'Cluster commands remained queued during failover');
      await waitForClientClusterPromotion(data.redis.client, key, promotedPort);
      await waitForClientClusterPromotion(stat.redis.client, key, promotedPort);
      await waitForEditorDataCommand(data, ['SET', key, 'after-failover'], 'OK');
      assert.equal(await waitForEditorDataCommand(data, ['GET', key]), 'after-failover');
      assert.equal(await stat.ping(), 'PONG');
    } finally {
      if (primaryStopped) {
        startContainer(primaryContainer);
      }
      await Promise.all([data.close(), stat.close()]);
    }
  }, 60000);
});

describeSentinelFailover('editorDataRedis Sentinel failover integration', () => {
  test('promotes the Sentinel replica, rejects a disconnected command, and reconnects the existing editorData client', async () => {
    const options = redisTopologyConfig.normalizeSentinelOptions(redisConfig().get('optionsSentinel') || {}, undefined);
    const sentinelHost = options.sentinelRootNodes[0].host;
    const sentinelPort = Number(options.sentinelRootNodes[0].port);
    const sentinelPassword = configuredPassword(options.sentinelClientOptions);
    const nodePassword = configuredPassword(options.nodeClientOptions);
    const data = new EditorData();
    const stat = new EditorStat();
    const key = `${process.env.TEST_REDIS_PREFIX}sentinel-failover:${randomUUID()}`;
    let primaryStopped = false;

    try {
      await data.connect();
      await stat.connect();
      assert.equal(await data.redis.command(['SET', key, 'before-failover']), 'OK');
      const currentMaster = data.redis.client.getMasterNode();
      assert.ok(currentMaster, 'Sentinel client did not expose its current master');
      // Keep the container DNS record available so Sentinel can resolve the
      // failed primary while it elects the replica.
      pauseContainer(process.env.TEST_REDIS_SENTINEL_PRIMARY_CONTAINER);
      primaryStopped = true;
      const promotedPort = Number(process.env.TEST_REDIS_SENTINEL_REPLICA_PORT);
      await triggerSentinelFailover(sentinelHost, sentinelPort, sentinelPassword, options.name);
      await waitForSentinelMaster(sentinelHost, sentinelPort, sentinelPassword, options.name, undefined, promotedPort);
      await withDirectClient(
        promotedPort,
        nodePassword,
        client =>
          waitFor(
            'Sentinel promoted master readiness',
            () => client.sendCommand(['ROLE']),
            reply => Array.isArray(reply) && reply[0] === 'master'
          ),
        'redis-replica'
      );
      data.redis.commandTimeoutMs = 1000;
      stat.redis.commandTimeoutMs = 1000;
      const duringFailover = await Promise.race([
        Promise.allSettled([data.redis.command(['SET', key, 'during-failover']), stat.redis.command(['PING']), data.ping(), stat.ping()]),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
      ]);
      assert.notEqual(duringFailover, 'timeout', 'Sentinel commands remained queued during failover');
      assert.notEqual(duringFailover[0].status, 'fulfilled', 'Sentinel write unexpectedly succeeded during failover');
      // maxCommandRediscovers is intentionally zero in production, so a
      // command that observed the old master fails fast. Abort those stale
      // clients, then verify that fresh adapters discover the promoted master.
      data.redis._abortClient();
      stat.redis._abortClient();
      const recoveredData = new EditorData();
      const recoveredStat = new EditorStat();
      try {
        await Promise.all([recoveredData.connect(), recoveredStat.connect()]);
        await waitForEditorDataCommand(recoveredData, ['SET', key, 'after-failover'], 'OK');
        assert.equal(await waitForEditorDataCommand(recoveredData, ['GET', key]), 'after-failover');
        assert.equal(await recoveredStat.ping(), 'PONG');
      } finally {
        await Promise.all([recoveredData.close(), recoveredStat.close()]);
      }
      assert.equal(
        await withDirectClient(
          Number(process.env.TEST_REDIS_SENTINEL_REPLICA_PORT),
          nodePassword,
          client => client.sendCommand(['GET', key]),
          'redis-replica'
        ),
        'after-failover'
      );
    } finally {
      if (primaryStopped) {
        unpauseContainer(process.env.TEST_REDIS_SENTINEL_PRIMARY_CONTAINER);
      }
      await Promise.all([data.close(), stat.close()]);
    }
  }, 40000);
});
