'use strict';

process.env.ALLOW_CONFIG_MUTATIONS = 'true';

const config = require('../../DocService/node_modules/config');

const redisConfig = config.get('services.CoAuthoring.redis');
const serverConfig = config.get('services.CoAuthoring.server');

process.env.TEST_REDIS_PREFIX = process.env.TEST_REDIS_PREFIX || `test:editor-data:${process.pid}:`;
process.env.TEST_REDIS_PROXY_DB = process.env.TEST_REDIS_PROXY_DB || '1';

redisConfig.prefix = process.env.TEST_REDIS_PREFIX;
serverConfig.editorDataStorage = 'editorDataRedis';
if (process.env.TEST_REDIS_CLUSTER === 'true') {
  redisConfig.optionsCluster = {
    rootNodes: process.env.TEST_REDIS_CLUSTER_NODES.split(',').map(url => ({url}))
  };
}

module.exports = config;
