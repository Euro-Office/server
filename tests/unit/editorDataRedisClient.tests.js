const {describe, test, expect} = require('@jest/globals');
const Redis = require('../../DocService/node_modules/ioredis');
const {createRedisClient} = require('../../DocService/sources/editorDataRedisClient');

// The image's entrypoint emits iooptions.sentinels unconditionally, listing
// the plain Redis server as its own sentinel when none is configured. That
// shape reaching `new Redis()` is what put a production deployment into
// sentinel mode, where it never connected - and since the locks fail closed,
// every save was refused with nothing in the log. These tests pin the
// selection, not the connection: lazyConnect keeps every client offline.
describe('editorDataRedisClient', () => {
  const fabricatedSentinels = {
    lazyConnect: true,
    sentinels: [{host: '127.0.0.1', port: 6379}],
    name: 'mymaster',
    sentinelPassword: '',
    username: 'default',
    password: 'secret'
  };

  function standaloneCfg(extra) {
    return Object.assign({host: '127.0.0.1', port: 6379, iooptions: fabricatedSentinels}, extra);
  }

  describe('standalone', () => {
    test('ignores a sentinels array nobody asked for, rather than entering sentinel mode', async () => {
      const client = createRedisClient(standaloneCfg());
      try {
        expect(client).toBeInstanceOf(Redis);
        expect(client).not.toBeInstanceOf(Redis.Cluster);
        // ioredis enters sentinel mode only for a non-empty sentinels
        // array, and normalises the absent case to null.
        expect(client.options.sentinels || []).toHaveLength(0);
        expect(client.options.host).toBe('127.0.0.1');
        expect(client.options.port).toBe(6379);
      } finally {
        client.disconnect();
      }
    });

    test('keeps the credentials and the fail-fast command timeout', async () => {
      const client = createRedisClient(standaloneCfg());
      try {
        expect(client.options.username).toBe('default');
        expect(client.options.password).toBe('secret');
        expect(client.options.commandTimeout).toBe(300);
      } finally {
        client.disconnect();
      }
    });

    test('an explicit commandTimeout in iooptions still wins', async () => {
      const cfg = standaloneCfg();
      cfg.iooptions = Object.assign({}, fabricatedSentinels, {commandTimeout: 1000});
      const client = createRedisClient(cfg);
      try {
        expect(client.options.commandTimeout).toBe(1000);
      } finally {
        client.disconnect();
      }
    });
  });

  describe('sentinel', () => {
    test('is opt-in: mode "sentinel" honours the sentinels the operator configured', async () => {
      const client = createRedisClient(standaloneCfg({mode: 'sentinel'}));
      try {
        expect(client.options.sentinels).toHaveLength(1);
        expect(client.options.name).toBe('mymaster');
      } finally {
        client.disconnect();
      }
    });

    // The fix for the fabricated array must not break the deployments that
    // genuinely run sentinel: those get a real list on sentinel ports, which
    // never matches the entrypoint's self-referential fallback.
    test('auto still picks sentinel for a credible sentinel list', () => {
      const cfg = {
        host: '127.0.0.1',
        port: 6379,
        iooptions: {
          lazyConnect: true,
          sentinels: [
            {host: 'sentinel-a', port: 26379},
            {host: 'sentinel-b', port: 26379}
          ],
          name: 'mymaster'
        }
      };
      const client = createRedisClient(cfg);
      try {
        expect(client.options.sentinels).toHaveLength(2);
      } finally {
        client.disconnect();
      }
    });

    test('auto ignores a single sentinel that is just the standalone server itself', () => {
      const client = createRedisClient(standaloneCfg());
      try {
        expect(client.options.sentinels || []).toHaveLength(0);
      } finally {
        client.disconnect();
      }
    });

    test('refuses mode "sentinel" with no sentinels rather than silently going standalone', () => {
      expect(() => createRedisClient({host: '127.0.0.1', port: 6379, mode: 'sentinel', iooptions: {lazyConnect: true}})).toThrow(
        /sentinels is empty/
      );
    });
  });

  describe('mode validation', () => {
    // The whole module exists to make misconfiguration loud. A selector that
    // guesses on a typo undoes that: the operator gets "connection refused"
    // and goes looking at Redis instead of at their own config.
    test('refuses an unrecognised mode rather than quietly going standalone', () => {
      for (const mode of ['Sentinel', 'sentinal', 'CLUSTER', ' standalone']) {
        expect(() => createRedisClient(standaloneCfg({mode}))).toThrow(/expected one of/);
      }
    });

    test('accepts every documented mode', () => {
      const cfgs = {
        auto: standaloneCfg({mode: 'auto'}),
        standalone: standaloneCfg({mode: 'standalone'}),
        sentinel: standaloneCfg({mode: 'sentinel'})
      };
      for (const [mode, cfg] of Object.entries(cfgs)) {
        const client = createRedisClient(cfg);
        try {
          expect(client).toBeInstanceOf(Redis);
        } finally {
          client.disconnect();
        }
        expect(mode).toBeTruthy();
      }
    });
  });

  describe('cluster', () => {
    // The entrypoint writes optionsCluster.rootNodes from REDIS_CLUSTER_NODES
    // as {url}, with credentials on optionsCluster.defaults.
    const clusterCfg = {
      host: '127.0.0.1',
      port: 6379,
      iooptions: fabricatedSentinels,
      optionsCluster: {
        rootNodes: [{url: 'redis://valkey-0:6379'}, {url: 'redis://valkey-1:6380'}],
        defaults: {username: 'cluster-user', password: 'cluster-pass'}
      }
    };

    test('auto-detects a cluster from rootNodes and parses host/port out of each url', async () => {
      const client = createRedisClient(clusterCfg);
      try {
        expect(client).toBeInstanceOf(Redis.Cluster);
        expect(client.startupNodes).toEqual([
          {host: 'valkey-0', port: 6379},
          {host: 'valkey-1', port: 6380}
        ]);
      } finally {
        client.disconnect();
      }
    });

    test('drops the sentinel-only options and takes credentials from optionsCluster.defaults', async () => {
      const client = createRedisClient(clusterCfg);
      try {
        expect(client.options.redisOptions.sentinels).toBeUndefined();
        expect(client.options.redisOptions.name).toBeUndefined();
        // iooptions had no username/password conflict here, so the cluster
        // defaults fill them in.
        const cfg = Object.assign({}, clusterCfg, {iooptions: {lazyConnect: true}});
        const bare = createRedisClient(cfg);
        try {
          expect(bare.options.redisOptions.username).toBe('cluster-user');
          expect(bare.options.redisOptions.password).toBe('cluster-pass');
        } finally {
          bare.disconnect();
        }
      } finally {
        client.disconnect();
      }
    });

    test('lazyConnect is set on the cluster itself, not only on redisOptions', async () => {
      const client = createRedisClient(clusterCfg);
      try {
        // A cluster that ignored lazyConnect would already be connecting.
        expect(client.status).toBe('wait');
      } finally {
        client.disconnect();
      }
    });

    // ioredis spreads redisOptions into each node client, and a node with a
    // db set issues SELECT, which a cluster rejects - the same shape of
    // silent connection failure this whole change exists to remove.
    test("drops the entrypoint's default db rather than letting a node SELECT on a cluster", () => {
      const cfg = Object.assign({}, clusterCfg, {iooptions: {lazyConnect: true, db: '0'}});
      const client = createRedisClient(cfg);
      try {
        expect(client.options.redisOptions.db).toBeUndefined();
      } finally {
        client.disconnect();
      }
    });

    test('refuses a non-zero db on a cluster instead of failing to connect later', () => {
      const cfg = Object.assign({}, clusterCfg, {iooptions: {lazyConnect: true, db: '3'}});
      expect(() => createRedisClient(cfg)).toThrow(/supports db 0 only/);
    });

    // commandTimeout is applied by the node client, and Cluster only reaches
    // a node once it is ready - until then it parks commands on its own
    // untimed queue and the default retry strategy retries forever. Left at
    // the default, an unreachable cluster hangs every save instead of denying
    // it, which is the fail-closed contract broken in the worst way: no
    // rejection, so nothing to report and nothing to retry.
    test('disables the cluster offline queue, so an unready cluster denies rather than hangs', () => {
      const client = createRedisClient(clusterCfg);
      try {
        expect(client.options.enableOfflineQueue).toBe(false);
      } finally {
        client.disconnect();
      }
    });

    // The config block ships two spellings of the node list. Reading only
    // one means a deployment configured the other way boots happily and runs
    // standalone against a single node - the healthy-looking, not-actually-
    // sharing failure cluster support exists to prevent.
    test('accepts the ioredis-flavoured iooptionsClusterNodes as well', () => {
      const cfg = {
        host: '127.0.0.1',
        port: 6379,
        iooptions: {lazyConnect: true},
        iooptionsClusterNodes: [
          {host: 'valkey-0', port: 6379},
          {host: 'valkey-1', port: 6380}
        ]
      };
      const client = createRedisClient(cfg);
      try {
        expect(client).toBeInstanceOf(Redis.Cluster);
        expect(client.startupNodes).toEqual([
          {host: 'valkey-0', port: 6379},
          {host: 'valkey-1', port: 6380}
        ]);
      } finally {
        client.disconnect();
      }
    });

    test('accepts a host/port pair or a bare host:port string under rootNodes', () => {
      const cfg = Object.assign({}, clusterCfg, {
        optionsCluster: {rootNodes: [{host: 'valkey-0', port: 6379}, 'valkey-1:6380']}
      });
      const client = createRedisClient(cfg);
      try {
        expect(client.startupNodes).toEqual([
          {host: 'valkey-0', port: 6379},
          {host: 'valkey-1', port: 6380}
        ]);
      } finally {
        client.disconnect();
      }
    });

    test('names the offending entry instead of throwing Invalid URL', () => {
      const cfg = Object.assign({}, clusterCfg, {optionsCluster: {rootNodes: [{nonsense: true}]}});
      expect(() => createRedisClient(cfg)).toThrow(/neither a url nor a host\/port pair/);
    });

    test('refuses mode "cluster" with no rootNodes rather than silently going standalone', () => {
      expect(() => createRedisClient({host: '127.0.0.1', port: 6379, mode: 'cluster', iooptions: {lazyConnect: true}})).toThrow(
        /rootNodes nor iooptionsClusterNodes is populated/
      );
    });
  });
});
