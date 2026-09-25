'use strict';

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');
const {applyTestRedisConfig, parseTestRedisConfig} = require('./testConfig');

const standaloneConfig = {host: '127.0.0.1', port: 6379};

function fakeConfig(redisOptions = {}, serverOptions = {}) {
  const redisConfig = {
    ...redisOptions,
    get(name) {
      return this[name];
    }
  };
  const serverConfig = {
    ...serverOptions,
    get(name) {
      return this[name];
    }
  };
  return {
    redisConfig,
    serverConfig,
    config: {
      get(path) {
        if (path === 'services.CoAuthoring.redis') {
          return redisConfig;
        }
        if (path === 'services.CoAuthoring.server') {
          return serverConfig;
        }
        throw new Error(`Unexpected config path: ${path}`);
      }
    }
  };
}

describe('Redis test configuration', () => {
  test('validates standalone configuration and applies defaults', () => {
    const result = parseTestRedisConfig({}, standaloneConfig);
    assert.equal(result.topology, 'standalone');
    assert.match(result.prefix, /^test:editor-data:/);
    assert.equal(result.proxyDatabase, 1);
    assert.deepEqual(result.standalone, standaloneConfig);
    assert.deepEqual(result.clusterNodes, []);
    assert.equal(result.sentinelName, null);
    assert.deepEqual(result.sentinelNodes, []);
  });

  test('parses Cluster endpoints', () => {
    const result = parseTestRedisConfig(
      {
        TEST_REDIS_CLUSTER: 'true',
        TEST_REDIS_CLUSTER_NODES: 'redis://127.0.0.1:7000,127.0.0.1:7001',
        TEST_REDIS_PREFIX: 'test:cluster:',
        TEST_REDIS_PROXY_DB: '2'
      },
      standaloneConfig
    );

    assert.equal(result.topology, 'cluster');
    assert.deepEqual(result.clusterNodes, [{url: 'redis://127.0.0.1:7000'}, {url: 'redis://127.0.0.1:7001'}]);
    assert.equal(result.proxyDatabase, 2);
  });

  test('parses Sentinel endpoints', () => {
    const result = parseTestRedisConfig(
      {
        TEST_REDIS_SENTINEL: 'true',
        TEST_REDIS_SENTINEL_NAME: 'mymaster',
        TEST_REDIS_SENTINEL_NODES: '127.0.0.1:26379,redis://127.0.0.1:26380',
        TEST_REDIS_PREFIX: 'test:sentinel:'
      },
      standaloneConfig
    );

    assert.equal(result.topology, 'sentinel');
    assert.equal(result.sentinelName, 'mymaster');
    assert.deepEqual(result.sentinelNodes, [
      {host: '127.0.0.1', port: 26379},
      {host: '127.0.0.1', port: 26380}
    ]);
  });

  test('applies Cluster topology without discarding existing options', () => {
    const testConfig = parseTestRedisConfig(
      {
        TEST_REDIS_CLUSTER: 'true',
        TEST_REDIS_CLUSTER_NODES: '127.0.0.1:7000',
        TEST_REDIS_PREFIX: 'test:cluster:'
      },
      standaloneConfig
    );
    const fake = fakeConfig(
      {
        optionsCluster: {
          defaults: {socket: {tls: true}},
          commandOptions: {timeout: 5000},
          rootNodes: [{url: 'redis://old-node:7000'}]
        },
        optionsSentinel: {name: 'unused-sentinel-config'}
      },
      {editorDataStorage: 'editorDataMemory'}
    );

    applyTestRedisConfig(fake.config, testConfig);

    assert.deepEqual(fake.redisConfig.optionsCluster, {
      defaults: {socket: {tls: true}},
      commandOptions: {timeout: 5000},
      rootNodes: [{url: 'redis://127.0.0.1:7000'}]
    });
    assert.deepEqual(fake.redisConfig.optionsSentinel, {});
    assert.equal(fake.redisConfig.prefix, 'test:cluster:');
    assert.equal(fake.serverConfig.editorDataStorage, 'editorDataRedis');
  });

  test('applies standalone topology and disables topology-specific options', () => {
    const testConfig = parseTestRedisConfig({TEST_REDIS_PREFIX: 'test:standalone:'}, standaloneConfig);
    const fake = fakeConfig(
      {
        optionsCluster: {rootNodes: [{url: 'redis://old-node:7000'}]},
        optionsSentinel: {name: 'old-master', sentinelRootNodes: [{host: 'old-sentinel', port: 26379}]}
      },
      {editorDataStorage: 'editorDataMemory'}
    );

    applyTestRedisConfig(fake.config, testConfig);

    assert.deepEqual(fake.redisConfig.optionsCluster, {});
    assert.deepEqual(fake.redisConfig.optionsSentinel, {});
    assert.equal(fake.redisConfig.prefix, 'test:standalone:');
    assert.equal(fake.serverConfig.editorDataStorage, 'editorDataRedis');
  });

  test('applies Sentinel topology without discarding existing options', () => {
    const testConfig = parseTestRedisConfig(
      {
        TEST_REDIS_SENTINEL: 'true',
        TEST_REDIS_SENTINEL_NAME: 'mymaster',
        TEST_REDIS_SENTINEL_NODES: '127.0.0.1:26379',
        TEST_REDIS_PREFIX: 'test:sentinel:'
      },
      standaloneConfig
    );
    const fake = fakeConfig(
      {
        optionsCluster: {rootNodes: [{url: 'redis://unused-node:7000'}]},
        optionsSentinel: {
          name: 'old-master',
          sentinelRootNodes: [{host: 'old-sentinel', port: 26379}],
          nodeClientOptions: {socket: {tls: true}, username: 'redis-user'},
          sentinelClientOptions: {password: 'sentinel-password'},
          commandOptions: {timeout: 5000}
        }
      },
      {editorDataStorage: 'editorDataMemory'}
    );

    applyTestRedisConfig(fake.config, testConfig);

    assert.deepEqual(fake.redisConfig.optionsSentinel, {
      name: 'mymaster',
      sentinelRootNodes: [{host: '127.0.0.1', port: 26379}],
      nodeClientOptions: {socket: {tls: true}, username: 'redis-user'},
      sentinelClientOptions: {password: 'sentinel-password'},
      commandOptions: {timeout: 5000}
    });
    assert.deepEqual(fake.redisConfig.optionsCluster, {});
    assert.equal(fake.redisConfig.prefix, 'test:sentinel:');
    assert.equal(fake.serverConfig.editorDataStorage, 'editorDataRedis');
  });

  test('rejects invalid topology flags and endpoints', () => {
    assert.throws(() => parseTestRedisConfig({TEST_REDIS_CLUSTER: 'yes'}, standaloneConfig), /TEST_REDIS_CLUSTER/);
    assert.throws(
      () =>
        parseTestRedisConfig(
          {
            TEST_REDIS_CLUSTER: 'true',
            TEST_REDIS_SENTINEL: 'true',
            TEST_REDIS_CLUSTER_NODES: '127.0.0.1:7000'
          },
          standaloneConfig
        ),
      /cannot both be true/
    );
    assert.throws(
      () => parseTestRedisConfig({TEST_REDIS_CLUSTER: 'true', TEST_REDIS_CLUSTER_NODES: '127.0.0.1:70000'}, standaloneConfig),
      /valid Redis endpoint|port/
    );
    assert.throws(
      () => parseTestRedisConfig({TEST_REDIS_SENTINEL: 'true', TEST_REDIS_SENTINEL_NODES: '127.0.0.1:26379,127.0.0.1:26379'}, standaloneConfig),
      /duplicate/
    );
    assert.throws(
      () => parseTestRedisConfig({TEST_REDIS_SENTINEL: 'true', TEST_REDIS_SENTINEL_NODES: 'rediss://127.0.0.1:26379'}, standaloneConfig),
      /Sentinel endpoints/
    );
    assert.throws(() => parseTestRedisConfig({TEST_REDIS_PREFIX: ''}, standaloneConfig), /TEST_REDIS_PREFIX/);
    assert.throws(() => parseTestRedisConfig({TEST_REDIS_PROXY_DB: ''}, standaloneConfig), /TEST_REDIS_PROXY_DB/);
    assert.throws(() => parseTestRedisConfig({TEST_REDIS_PROXY_DB: '1.5'}, standaloneConfig), /TEST_REDIS_PROXY_DB/);
    assert.throws(() => parseTestRedisConfig({TEST_REDIS_PROXY_DB: '-1'}, standaloneConfig), /TEST_REDIS_PROXY_DB/);
    assert.throws(() => parseTestRedisConfig({}, {host: '127.0.0.1', port: ' '}), /services\.CoAuthoring\.redis\.port/);
  });
});
