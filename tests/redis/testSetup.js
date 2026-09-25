'use strict';

process.env.ALLOW_CONFIG_MUTATIONS = 'true';

const config = require('../../DocService/node_modules/config');
const {applyTestRedisConfig, parseTestRedisConfig} = require('./testConfig');

const redisConfig = config.get('services.CoAuthoring.redis');
const testRedisConfig = parseTestRedisConfig(process.env, {
  host: redisConfig.get('host'),
  port: redisConfig.get('port')
});

process.env.TEST_REDIS_PREFIX = testRedisConfig.prefix;
process.env.TEST_REDIS_PROXY_DB = String(testRedisConfig.proxyDatabase);

applyTestRedisConfig(config, testRedisConfig);

module.exports = config;
