'use strict';

const config = require('../../DocService/node_modules/config');
const redis = require('../../DocService/node_modules/redis');
const redisTopologyConfig = require('../../DocService/sources/editorDataRedis/redisConfig');

const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function redisConfig() {
  return config.get('services.CoAuthoring.redis');
}

function createTopologyClient() {
  const configured = redisConfig();
  if (process.env.TEST_REDIS_SENTINEL === 'true') {
    return redis.createSentinel(redisTopologyConfig.normalizeSentinelOptions(configured.get('optionsSentinel') || {}, undefined));
  }
  if (process.env.TEST_REDIS_CLUSTER === 'true') {
    return redis.createCluster(redisTopologyConfig.normalizeClusterOptions(configured.get('optionsCluster') || {}));
  }
  return redis.createClient(redisTopologyConfig.normalizeNodeOptions(configured.get('options') || {}, undefined));
}

async function createRedisClient() {
  const client = createTopologyClient();
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function cleanupRedisClient(client, prefix) {
  for await (const keys of client.scanIterator({MATCH: `${prefix}*`, COUNT: 1000})) {
    for (let index = 0; index < keys.length; index += 100) {
      await Promise.all(keys.slice(index, index + 100).map(key => client.del(key)));
    }
  }
}

async function cleanupRedisPrefix(prefix) {
  const client = await createRedisClient();
  try {
    if (process.env.TEST_REDIS_CLUSTER === 'true') {
      for (const master of client.masters) {
        await cleanupRedisClient(master.client, prefix);
      }
    } else {
      await cleanupRedisClient(client, prefix);
    }
  } finally {
    await client.close();
  }
}

async function waitFor(scenario, operation, predicate, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
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
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`${scenario} timed out; last value: ${JSON.stringify(lastValue)}; last error: ${lastError?.message || 'none'}`);
}

module.exports = {cleanupRedisPrefix, redisConfig, waitFor};
