'use strict';

const Redis = require('ioredis');

// Builds the ioredis client for the topology the deployment actually runs.
//
// The image's entrypoint emits `iooptions.sentinels` unconditionally, and
// when no sentinel is configured it lists the plain Redis server as its own
// sentinel. Spreading that into `new Redis()` puts ioredis into sentinel
// mode on every non-sentinel deployment, where it never connects - and
// because the locks fail closed, that is a total save outage on a
// deployment that looks healthy. So sentinel is opt-in here rather than
// inferred from a config block we did not write.
//
// See REDIS_EDITORDATA.md.

// ioredis parks a lazyConnect client at "wait" until a command arrives;
// EditorData.connect() kicks it. Redis.Cluster reports the same "wait" and
// "ready" statuses, so the health-check plumbing is topology-independent.
const SENTINEL_ONLY_OPTIONS = ['sentinels', 'name', 'sentinelPassword', 'role'];

// Failing closed only works if the failure arrives quickly: ioredis defaults
// to no command timeout at all, so a stalled connection would hang save and
// auth for every user on the document.
const DEFAULT_COMMAND_TIMEOUT = 300;

// Every topology disables the offline queue, and commandTimeout is not a
// substitute for it. The timeout settles the *promise* - Command.setTimeout
// rejects it - but the command object stays on ioredis's offlineQueue, and
// the ready handler re-sends every queued entry on reconnect with no check
// for whether its promise already settled. So a lockSave that timed out and
// was correctly reported as denied would execute for real seconds later,
// taking a lock the caller has already given up on and will never release:
// a save outage outliving the Redis blip by the whole lock TTL, and
// indistinguishable in the log from a legitimate lock.
//
// The cost is that commands issued before the client is ready are rejected
// rather than held. That is the fail-closed behaviour we want, and
// EditorData.connect() is called at boot, so steady-state traffic is
// unaffected.
//
// Applied *after* the operator's options in every branch, deliberately: an
// ioredis tuning snippet pasted into `iooptions` with enableOfflineQueue
// true would otherwise reinstate the replay silently.
const FAIL_CLOSED_CONNECTION = {enableOfflineQueue: false};

// Cluster nodes arrive in two shapes. The orchestrated entrypoint writes
// optionsCluster.rootNodes as {url}; the config block's sibling
// iooptionsClusterNodes is the ioredis-flavoured {host, port}. Accept both,
// and a bare "host:port" string, rather than throwing an opaque Invalid URL.
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

// The entrypoint's fabricated fallback is a single sentinel pointing at the
// standalone server itself. A real sentinel list never looks like that -
// sentinels run on their own port - so this is what lets 'auto' tell a
// configured sentinel deployment from an invented one. An explicit `mode`
// always wins over the guess.
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
    // A cluster has only db 0. SELECT 0 is accepted there, so carrying the
    // entrypoint's default through would work - it is dropped only to save a
    // pointless SELECT on every node connection. A non-zero db is the real
    // problem: nothing on a cluster can honour it, so say so rather than fail
    // to connect later.
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
    // lazyConnect is a Cluster-level option, not a redisOptions one.
    //
    // enableOfflineQueue: false is what makes the locks actually fail closed
    // here. commandTimeout is applied by the *node* client, and Cluster only
    // reaches a node once it is ready; before that it parks commands on its
    // own untimed queue, and the default clusterRetryStrategy retries
    // forever. Left at the default, an unreachable cluster would hang every
    // save and auth indefinitely instead of denying them - no timeout, no
    // rejection, and so nothing for the failure reporter to report.
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
