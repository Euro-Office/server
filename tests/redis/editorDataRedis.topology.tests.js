'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const redis = require('../../DocService/node_modules/redis');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const redisTopologyConfig = require('../../DocService/sources/editorDataRedis/redisConfig');

const WAIT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 100;

function redisConfig() {
  return config.get('services.CoAuthoring.redis');
}

function configuredPassword(options) {
  return options.password || undefined;
}

function createDirectClient(port, password) {
  const client = redis.createClient({
    socket: {host: '127.0.0.1', port},
    ...(password === undefined ? {} : {password})
  });
  client.on('error', () => {});
  return client;
}

async function withDirectClient(port, password, operation) {
  const client = createDirectClient(port, password);
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
      return {id: fields[0], host, port: Number(port), flags: fields[2].split(',')};
    });
}

async function waitForClusterPromotion(rootPort, password, promotedPort) {
  return withDirectClient(rootPort, password, client =>
    waitFor(
      `Cluster replica ${promotedPort} promotion`,
      () => client.sendCommand(['CLUSTER', 'NODES']),
      reply => clusterNodeRecords(reply).some(node => node.port === promotedPort && node.flags.includes('master'))
    )
  );
}

async function promoteClusterReplica(replicaPort, password) {
  await withDirectClient(replicaPort, password, client => client.sendCommand(['CLUSTER', 'FAILOVER']));
}

async function waitForSentinelMaster(sentinelPort, sentinelPassword, masterName, expectedPort) {
  return withDirectClient(sentinelPort, sentinelPassword, client =>
    waitFor(
      `Sentinel promotion to ${expectedPort}`,
      () => client.sendCommand(['SENTINEL', 'GET-MASTER-ADDR-BY-NAME', masterName]),
      reply => Array.isArray(reply) && String(reply[1]) === String(expectedPort)
    )
  );
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

test('uses independent editor-data and editor-stat clients on the configured topology', async () => {
  const data = new EditorData();
  const stat = new EditorStat();

  try {
    assert.notEqual(data.redis, stat.redis);
    await Promise.all([data.connect(), stat.connect()]);
    assert.equal(await data.ping(), 'PONG');
    assert.equal(await stat.ping(), 'PONG');
  } finally {
    await Promise.all([data.close(), stat.close()]);
  }
}, 30000);

describeClusterFailover('editorDataRedis Cluster failover integration', () => {
  test('promotes a Cluster replica and reconnects the existing editorData client', async () => {
    const options = redisTopologyConfig.normalizeClusterOptions(redisConfig().get('optionsCluster') || {});
    const rootPort = Number(options.rootNodes[0].url.split(':').pop());
    const promotedPort = Number(process.env.TEST_REDIS_CLUSTER_FAILOVER_REPLICA_PORT);
    const data = new EditorData();
    const key = `${process.env.TEST_REDIS_PREFIX}cluster-failover:${randomUUID()}`;

    try {
      await data.connect();
      assert.equal(await data.redis.command(['SET', key, 'before-failover']), 'OK');
      await promoteClusterReplica(promotedPort, configuredPassword(options.defaults));
      await waitForClusterPromotion(rootPort, configuredPassword(options.defaults), promotedPort);
      await waitForEditorDataCommand(data, ['SET', key, 'after-failover'], 'OK');
      assert.equal(await waitForEditorDataCommand(data, ['GET', key]), 'after-failover');
    } finally {
      await data.close();
    }
  }, 30000);
});

describeSentinelFailover('editorDataRedis Sentinel failover integration', () => {
  test('promotes the Sentinel replica, rejects a disconnected command, and reconnects the existing editorData client', async () => {
    const options = redisTopologyConfig.normalizeSentinelOptions(redisConfig().get('optionsSentinel') || {}, undefined);
    const sentinelPort = Number(options.sentinelRootNodes[0].port);
    const sentinelPassword = configuredPassword(options.sentinelClientOptions);
    const nodePassword = configuredPassword(options.nodeClientOptions);
    const data = new EditorData();
    const key = `${process.env.TEST_REDIS_PREFIX}sentinel-failover:${randomUUID()}`;

    try {
      await data.connect();
      assert.equal(await data.redis.command(['SET', key, 'before-failover']), 'OK');
      stopContainer(process.env.TEST_REDIS_SENTINEL_PRIMARY_CONTAINER);
      await waitForSentinelMaster(sentinelPort, sentinelPassword, options.name, Number(process.env.TEST_REDIS_SENTINEL_REPLICA_PORT));
      data.redis.commandTimeoutMs = 1000;
      await assert.rejects(
        data.redis.command(['SET', key, 'during-failover']),
        error =>
          error.code === 'REDIS_UNAVAILABLE' || error.code === 'ETIMEDOUT' || /no valid master|socket closed|connection ended/i.test(error.message)
      );
      await waitForEditorDataCommand(data, ['SET', key, 'after-failover'], 'OK');
      assert.equal(await waitForEditorDataCommand(data, ['GET', key]), 'after-failover');
      assert.equal(
        await withDirectClient(Number(process.env.TEST_REDIS_SENTINEL_REPLICA_PORT), nodePassword, client => client.sendCommand(['GET', key])),
        'after-failover'
      );
    } finally {
      await data.close();
    }
  }, 40000);
});
