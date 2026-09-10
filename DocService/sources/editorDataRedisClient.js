'use strict';

const Redis = require('ioredis');

// Builds the ioredis client for the topology the deployment runs.
// See REDIS_EDITORDATA.md for why each choice below is made the way it is.

const SENTINEL_ONLY_OPTIONS = ['sentinels', 'name', 'sentinelPassword', 'role'];

// ioredis defaults to no command timeout, so a stalled connection would hang
// save and auth rather than denying them.
const DEFAULT_COMMAND_TIMEOUT = 300;

// commandTimeout settles the promise but leaves the command on ioredis's
// offline queue, and the ready handler re-sends it on reconnect - so a lock
// reported as denied would be taken for real later and never released.
// Applied last in every branch: operator iooptions must not re-enable it.
const FAIL_CLOSED_CONNECTION = {enableOfflineQueue: false};

// The entrypoint writes {url}; the config block's iooptionsClusterNodes is
// {host, port}. Accept both, and "host:port", with a usable error otherwise.
function clusterNodes(nodes) {
  return nodes.map(node => {
    if (node && undefined !== node.host) {
      return {host: node.host, port: Number(node.port) || 6379};
    }
    const raw = typeof node === 'string' ? node : node && node.url;
    if (!raw) {
      throw new Error(`services.CoAuthoring.redis cluster node is neither a url nor a host/port pair: ${JSON.stringify(node)}`);
    }
    const withScheme = raw.includes('://') ? raw : `redis://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`services.CoAuthoring.redis cluster node is not a usable address: ${raw}`);
    }
    return {host: url.hostname, port: Number(url.port) || 6379};
  });
}

function withoutSentinelOptions(options) {
  const res = Object.assign({}, options);
  for (const key of SENTINEL_ONLY_OPTIONS) {
    delete res[key];
  }
  return res;
}

// The entrypoint's fallback is a lone sentinel pointing at the standalone
// server itself; a real sentinel list never looks like that. This is what
// lets 'auto' tell a configured sentinel deployment from an invented one.
function looksFabricated(redisCfg, sentinels) {
  return 1 === sentinels.length && sentinels[0].host === redisCfg.host && Number(sentinels[0].port) === Number(redisCfg.port);
}

const MODES = ['auto', 'standalone', 'sentinel', 'cluster'];

// `mode`: 'auto' (default) picks cluster when cluster nodes are configured,
// sentinel when a credible sentinel list is, and standalone otherwise;
// 'standalone', 'sentinel' and 'cluster' force one.
function createRedisClient(redisCfg) {
  const options = Object.assign({commandTimeout: DEFAULT_COMMAND_TIMEOUT}, redisCfg.iooptions || {});
  const cluster = redisCfg.optionsCluster || {};
  // Either spelling of the node list; the two are alternatives, not a merge.
  const rootNodes = cluster.rootNodes && cluster.rootNodes.length ? cluster.rootNodes : redisCfg.iooptionsClusterNodes || [];
  const mode = redisCfg.mode || 'auto';

  // A typo must not quietly become standalone. Everything this module does
  // to make misconfiguration loud is wasted if the topology selector itself
  // guesses, and "connection refused" sends an operator after Redis rather
  // than after their own config.
  if (!MODES.includes(mode)) {
    throw new Error(`services.CoAuthoring.redis.mode is "${mode}"; expected one of ${MODES.join(', ')}`);
  }

  if ('cluster' === mode || ('auto' === mode && rootNodes.length > 0)) {
    if (0 === rootNodes.length) {
      throw new Error(
        'editorDataStorage redis mode is "cluster" but neither services.CoAuthoring.redis.optionsCluster.rootNodes nor iooptionsClusterNodes is populated'
      );
    }
    const redisOptions = withoutSentinelOptions(options);
    // A cluster has only db 0. Dropping the default saves a pointless SELECT
    // per node; a non-zero db cannot be honoured at all, so say so here.
    if (undefined !== redisOptions.db) {
      if (0 !== Number(redisOptions.db)) {
        throw new Error(`editorDataStorage redis mode is "cluster", which supports db 0 only, but db ${redisOptions.db} is configured`);
      }
      delete redisOptions.db;
    }
    // The entrypoint puts cluster credentials on optionsCluster.defaults,
    // separately from the standalone block.
    const defaults = cluster.defaults || {};
    if (defaults.username && !redisOptions.username) {
      redisOptions.username = defaults.username;
    }
    if (defaults.password && !redisOptions.password) {
      redisOptions.password = defaults.password;
    }
    // lazyConnect is a Cluster-level option, not a redisOptions one. The
    // offline queue matters most here: commandTimeout is applied by the node
    // client, which a cluster only reaches once it is ready.
    return new Redis.Cluster(
      clusterNodes(rootNodes),
      Object.assign({}, redisCfg.iooptionsClusterOptions || {}, FAIL_CLOSED_CONNECTION, {
        redisOptions,
        lazyConnect: !!options.lazyConnect
      })
    );
  }

  const sentinels = options.sentinels || [];
  if ('sentinel' === mode) {
    if (0 === sentinels.length) {
      throw new Error('editorDataStorage redis mode is "sentinel" but services.CoAuthoring.redis.iooptions.sentinels is empty');
    }
    return new Redis(Object.assign({}, options, FAIL_CLOSED_CONNECTION));
  }

  if ('auto' === mode && sentinels.length > 0 && !looksFabricated(redisCfg, sentinels)) {
    return new Redis(Object.assign({}, options, FAIL_CLOSED_CONNECTION));
  }

  return new Redis(Object.assign({host: redisCfg.host, port: redisCfg.port}, withoutSentinelOptions(options), FAIL_CLOSED_CONNECTION));
}

module.exports = {createRedisClient};
