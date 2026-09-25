'use strict';

const DEFAULT_SENTINEL_NAME = 'mymaster';
const DEFAULT_PROXY_DB = '1';

function invalid(name, detail) {
  throw new Error(`Invalid ${name}: ${detail}`);
}

function hasControlCharacters(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function parseBoolean(value, name) {
  if (value === undefined) {
    return false;
  }
  if (value !== 'true' && value !== 'false') {
    invalid(name, 'expected "true" or "false"');
  }
  return value === 'true';
}

function parsePort(value, name) {
  const port = parseInteger(value, /^\d+$/, 1, 65535);
  if (port === null) {
    invalid(name, 'expected an integer between 1 and 65535');
  }
  return port;
}

function parseHost(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value) || hasControlCharacters(value)) {
    invalid(name, 'expected a non-empty host name');
  }
  return value.trim();
}

function parseInteger(value, pattern, minimum, maximum) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !pattern.test(value))) {
    return null;
  }

  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < minimum || (maximum !== undefined && integer > maximum)) {
    return null;
  }
  return integer;
}

function parsePrefix(value) {
  const prefix = value ?? `test:editor-data:${process.pid}:`;
  if (typeof prefix !== 'string' || prefix.length === 0 || hasControlCharacters(prefix)) {
    invalid('TEST_REDIS_PREFIX', 'expected a non-empty Redis key prefix without control characters');
  }
  return prefix;
}

function parseDatabase(value) {
  const database = parseInteger(value ?? DEFAULT_PROXY_DB, /^-?\d+$/, 0);
  if (database === null) {
    invalid('TEST_REDIS_PROXY_DB', 'expected a non-negative integer');
  }
  return database;
}

function parseRedisEndpoint(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(name, 'expected a host:port or redis[s]://host:port endpoint');
  }

  const endpoint = value.trim();
  const urlValue = endpoint.includes('://') ? endpoint : `redis://${endpoint}`;
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch (error) {
    invalid(name, `is not a valid Redis endpoint (${error.message})`);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    invalid(name, 'must use the redis:// or rediss:// protocol');
  }
  if (!parsed.hostname || !parsed.port) {
    invalid(name, 'must include both a host and an explicit port');
  }
  if (parsed.username || parsed.password || (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    invalid(name, 'must not include credentials, a path, a query, or a fragment');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hasControlCharacters(host) || /\s/.test(host)) {
    invalid(name, 'must include a valid host');
  }
  const port = parsePort(parsed.port, `${name} port`);
  return {host, port, protocol: parsed.protocol, url: parsed.toString()};
}

function parseEndpointList(value, name, output) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(name, 'expected a comma-separated list of endpoints');
  }

  const endpoints = value.split(',').map((endpoint, index) => parseRedisEndpoint(endpoint, `${name}[${index}]`));
  const uniqueEndpoints = new Set(endpoints.map(endpoint => `${endpoint.host}:${endpoint.port}`));
  if (uniqueEndpoints.size !== endpoints.length) {
    invalid(name, 'must not contain duplicate endpoints');
  }

  if (output === 'sentinel' && endpoints.some(endpoint => endpoint.protocol !== 'redis:')) {
    invalid(name, 'Sentinel endpoints must use redis:// or host:port');
  }

  return endpoints.map(endpoint => (output === 'sentinel' ? {host: endpoint.host, port: endpoint.port} : {url: endpoint.url}));
}

function parseSentinelName(value) {
  const name = value ?? DEFAULT_SENTINEL_NAME;
  if (typeof name !== 'string' || name.trim() === '' || /\s/.test(name) || hasControlCharacters(name)) {
    invalid('TEST_REDIS_SENTINEL_NAME', 'expected a non-empty name without whitespace or control characters');
  }
  return name;
}

function parseTestRedisConfig(env, standaloneConfig) {
  const cluster = parseBoolean(env.TEST_REDIS_CLUSTER, 'TEST_REDIS_CLUSTER');
  const sentinel = parseBoolean(env.TEST_REDIS_SENTINEL, 'TEST_REDIS_SENTINEL');
  if (cluster && sentinel) {
    throw new Error('TEST_REDIS_CLUSTER and TEST_REDIS_SENTINEL cannot both be true');
  }

  const host = parseHost(standaloneConfig.host, 'services.CoAuthoring.redis.host');
  const port = parsePort(standaloneConfig.port, 'services.CoAuthoring.redis.port');
  const result = {
    topology: sentinel ? 'sentinel' : cluster ? 'cluster' : 'standalone',
    prefix: parsePrefix(env.TEST_REDIS_PREFIX),
    proxyDatabase: parseDatabase(env.TEST_REDIS_PROXY_DB),
    standalone: {host, port},
    clusterNodes: [],
    sentinelName: null,
    sentinelNodes: []
  };

  if (cluster) {
    result.clusterNodes = parseEndpointList(env.TEST_REDIS_CLUSTER_NODES, 'TEST_REDIS_CLUSTER_NODES', 'cluster');
  }
  if (sentinel) {
    result.sentinelName = parseSentinelName(env.TEST_REDIS_SENTINEL_NAME);
    result.sentinelNodes = parseEndpointList(env.TEST_REDIS_SENTINEL_NODES, 'TEST_REDIS_SENTINEL_NODES', 'sentinel');
  }

  return result;
}

function applyTestRedisConfig(config, testRedisConfig) {
  const redisConfig = config.get('services.CoAuthoring.redis');
  const serverConfig = config.get('services.CoAuthoring.server');
  const existingClusterOptions = redisConfig.get('optionsCluster') || {};
  const existingSentinelOptions = redisConfig.get('optionsSentinel') || {};

  redisConfig.prefix = testRedisConfig.prefix;
  serverConfig.editorDataStorage = 'editorDataRedis';
  redisConfig.optionsCluster =
    testRedisConfig.topology === 'cluster'
      ? {
          ...existingClusterOptions,
          rootNodes: testRedisConfig.clusterNodes
        }
      : {};
  redisConfig.optionsSentinel =
    testRedisConfig.topology === 'sentinel'
      ? {
          ...existingSentinelOptions,
          name: testRedisConfig.sentinelName,
          sentinelRootNodes: testRedisConfig.sentinelNodes,
          nodeClientOptions: {...(existingSentinelOptions.nodeClientOptions || {})},
          sentinelClientOptions: {...(existingSentinelOptions.sentinelClientOptions || {})}
        }
      : {};
}

module.exports = {applyTestRedisConfig, parseTestRedisConfig};
