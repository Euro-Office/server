'use strict';

process.env.ALLOW_CONFIG_MUTATIONS = 'true';

const config = require('../../DocService/node_modules/config');
const commonConfig = require('../../Common/node_modules/config');
const {applyTestRedisConfig, parseTestRedisConfig} = require('./testConfig');

commonConfig.get('log.options').disableClustering = true;

const redisConfig = config.get('services.CoAuthoring.redis');
const testRedisConfig = parseTestRedisConfig(process.env, {
  host: redisConfig.get('host'),
  port: redisConfig.get('port')
});

process.env.TEST_REDIS_PREFIX = testRedisConfig.prefix;
process.env.TEST_REDIS_PROXY_DB = String(testRedisConfig.proxyDatabase);

applyTestRedisConfig(config, testRedisConfig);
applyTestRedisConfig(commonConfig, testRedisConfig);

module.exports = config;
