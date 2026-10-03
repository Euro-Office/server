/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const RedisConnection = require('./redisConnection/base');
const attachConnect = require('./redisConnection/connect');
const attachCommands = require('./redisConnection/commands');
const attachLifecycle = require('./redisConnection/lifecycle');
const helpers = require('./redisConnection/helpers');
const config = require('./redisConfig');

attachConnect(RedisConnection);
attachCommands(RedisConnection);
attachLifecycle(RedisConnection);

module.exports = {
  RedisConnection,
  log: helpers.log,
  errorDetails: helpers.errorDetails,
  createSentinelClient: helpers.createSentinelClient,
  normalizeNodeOptions: config.normalizeNodeOptions,
  normalizeClusterOptions: config.normalizeClusterOptions,
  normalizeSentinelOptions: config.normalizeSentinelOptions,
  sentinelReconnectStrategy: config.sentinelReconnectStrategy,
  RedisUnavailableError: helpers.RedisUnavailableError,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES: config.REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS: config.REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS: config.REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH: config.REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES: config.REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS: config.REDIS_SENTINEL_MAX_COMMAND_REDISCOVERS,
  REDIS_UNAVAILABLE_CODE: helpers.REDIS_UNAVAILABLE_CODE
};
