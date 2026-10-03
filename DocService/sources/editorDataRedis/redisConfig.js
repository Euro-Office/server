/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const base = require('./redisConfig/base');
const {normalizeNodeOptions} = require('./redisConfig/nodeOptions');
const {normalizeClusterOptions, hasNodeCluster} = require('./redisConfig/clusterOptions');
const {normalizeSentinelOptions, sentinelReconnectStrategy, hasNodeSentinel} = require('./redisConfig/sentinelOptions');

module.exports = {
  REDIS_CONNECT_TIMEOUT_MS: base.REDIS_CONNECT_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS: base.REDIS_COMMAND_TIMEOUT_MS,
  REDIS_RESP_VERSION: base.REDIS_RESP_VERSION,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES: base.REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS: base.REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS: base.REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH: base.REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES: base.REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS: base.REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS,
  cfgRedisName: base.cfgRedisName,
  cfgRedisHost: base.cfgRedisHost,
  cfgRedisPort: base.cfgRedisPort,
  cfgRedisOptions: base.cfgRedisOptions,
  cfgRedisOptionsCluster: base.cfgRedisOptionsCluster,
  cfgRedisOptionsSentinel: base.cfgRedisOptionsSentinel,
  normalizeNodeOptions,
  normalizeClusterOptions,
  normalizeSentinelOptions,
  sentinelReconnectStrategy,
  hasNodeCluster,
  hasNodeSentinel
};
