/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const base = require('./redisConfig/base');
const {normalizeNodeOptions} = require('./redisConfig/nodeOptions');
const {normalizeClusterOptions, hasNodeCluster} = require('./redisConfig/clusterOptions');
const {normalizeSentinelOptions, sentinelReconnectStrategy, hasNodeSentinel} = require('./redisConfig/sentinelOptions');

// The adapter's timeout for a command that was already sent: node-redis stops
// its commandOptions.timeout once the command is written. A positive
// commandOptions.timeout of the configured topology replaces the default;
// null or 0 (no library timeout) keep it, because a command that is never
// answered would otherwise hold the serialized editor-data lane forever. An
// invalid value keeps the default here and is reported when the client is
// created.
function configuredCommandTimeoutMs() {
  try {
    const source = hasNodeCluster() ? base.cfgRedisOptionsCluster : hasNodeSentinel() ? base.cfgRedisOptionsSentinel : base.cfgRedisOptions;
    const timeout = base.normalizeCommandOptions(source?.commandOptions).timeout;
    return timeout > 0 ? timeout : base.REDIS_COMMAND_TIMEOUT_MS;
  } catch (_error) {
    return base.REDIS_COMMAND_TIMEOUT_MS;
  }
}

module.exports = {
  configuredCommandTimeoutMs,
  REDIS_CONNECT_TIMEOUT_MS: base.REDIS_CONNECT_TIMEOUT_MS,
  REDIS_COMMAND_TIMEOUT_MS: base.REDIS_COMMAND_TIMEOUT_MS,
  REDIS_RESP_VERSION: base.REDIS_RESP_VERSION,
  REDIS_SENTINEL_RECONNECT_MAX_RETRIES: base.REDIS_SENTINEL_RECONNECT_MAX_RETRIES,
  REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS: base.REDIS_SENTINEL_RECONNECT_BASE_DELAY_MS,
  REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS: base.REDIS_SENTINEL_RECONNECT_MAX_DELAY_MS,
  REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH: base.REDIS_SENTINEL_COMMAND_QUEUE_MAX_LENGTH,
  REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES: base.REDIS_SENTINEL_INITIAL_DISCOVERY_MAX_RETRIES,
  REDIS_SENTINEL_MIN_ATTEMPT_MS: base.REDIS_SENTINEL_MIN_ATTEMPT_MS,
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
