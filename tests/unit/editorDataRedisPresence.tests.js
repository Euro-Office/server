const {describe, test, expect, beforeAll, afterAll, jest} = require('@jest/globals');
const path = require('path');
// Only installed under DocService/node_modules, not at this level - same
// explicit-path convention tests/integration uses for Common-only packages.
const {RedisMemoryServer} = require('../../DocService/node_modules/redis-memory-server');
const Redis = require('../../DocService/node_modules/ioredis');
const {buildKey} = require('../../DocService/sources/editorDataRedisKeys');

// A joiner on a DIFFERENT replica correctly seeing an existing editor is the
// thing editorDataMemory structurally cannot do - each replica's own
// getPresence only ever sees its own local connections.
describe('editorDataRedisLocks presence', () => {
  let redisServer;
  let host;
  let port;
  let editorDataMemory;
  let editorDataRedisLocks;
  let createPresenceStore;
  // Matches tenants.defaultTenant (default.json) - some presence paths key
  // off the configured default tenant, not an arbitrary string.
  const ctx = {tenant: 'localhost'};

  beforeAll(async () => {
    redisServer = new RedisMemoryServer();
    host = await redisServer.getHost();
    port = await redisServer.getPort();

    process.env.NODE_CONFIG_DIR = process.env.EO_CONFIG_DIR || path.join(__dirname, '..', '..', 'Common', 'config');
    process.env.NODE_CONFIG = JSON.stringify({
      log: {options: {replaceConsole: false}},
      services: {
        CoAuthoring: {
          redis: {host, port, prefix: 'presence-test:'}
        }
      }
    });

    editorDataMemory = require('../../DocService/sources/editorDataMemory');
    editorDataRedisLocks = require('../../DocService/sources/editorDataRedisLocks');
    ({createPresenceStore} = require('../../DocService/sources/editorDataRedisPresence'));
  }, 30000);

  afterAll(async () => {
    await redisServer.stop();
  });

  test('a joiner on a different replica sees the existing editor', async () => {
    const replicaA = new editorDataRedisLocks.EditorData();
    const replicaB = new editorDataRedisLocks.EditorData();
    await replicaA.connect();
    await replicaB.connect();
    const docId = 'doc-cross-replica';

    try {
      // Owner connects on replica A - its own local `connections` array (not
      // used by the Redis path at all, only by the fail-open fallback) is
      // irrelevant here; what matters is whether replica B's getPresence
      // sees it with zero local connections of its own.
      await replicaA.addPresence(ctx, docId, 'uid-owner-1', JSON.stringify({id: 'uid-1', connectionId: 'uid-owner-1', view: false}));

      const seenFromB = await replicaB.getPresence(ctx, docId, []);
      expect(seenFromB).toHaveLength(1);
      expect(JSON.parse(seenFromB[0])).toMatchObject({connectionId: 'uid-owner-1'});
    } finally {
      await replicaA.cleanDocumentOnExit(ctx, docId);
      await replicaA.close();
      await replicaB.close();
    }
  });

  // Not testable by racing getPresence against a write: getPresence filters
  // out exactly the inconsistent case (a live ZSET member with no matching
  // HASH field) rather than surfacing it, so a version of this test that
  // read through getPresence could never fail even if the write weren't
  // atomic. Inspect both raw Redis structures directly instead, on a
  // separate connection from the one doing the writes.
  test('write and remove never leave the HASH and ZSET disagreeing, across many rounds', async () => {
    const writer = new editorDataRedisLocks.EditorData();
    const raw = new Redis({host, port});
    await writer.connect();
    const docId = 'doc-atomicity';
    const hashKey = buildKey('presence-test:presence:', ctx.tenant, docId);
    const expKey = buildKey('presence-test:presenceExp:', ctx.tenant, docId);
    const ROUNDS = 30;

    try {
      for (let i = 0; i < ROUNDS; i++) {
        const connId = `conn-${i}`;
        await writer.addPresence(ctx, docId, connId, JSON.stringify({id: 'uid-x', connectionId: connId, view: false}));
        const [inHashAfterWrite, inZsetAfterWrite] = await Promise.all([
          raw.hexists(hashKey, connId).then(v => v === 1),
          raw.zscore(expKey, connId).then(v => v != null)
        ]);
        expect(inHashAfterWrite).toBe(inZsetAfterWrite);

        await writer.removePresence(ctx, docId, connId);
        const [inHashAfterRemove, inZsetAfterRemove] = await Promise.all([
          raw.hexists(hashKey, connId).then(v => v === 1),
          raw.zscore(expKey, connId).then(v => v != null)
        ]);
        expect(inHashAfterRemove).toBe(false);
        expect(inZsetAfterRemove).toBe(false);
      }
    } finally {
      await writer.cleanDocumentOnExit(ctx, docId);
      await writer.close();
      await raw.quit();
    }
  });

  // These need a short TTL to run fast, which the real config
  // (services.CoAuthoring.expire.presence) doesn't give us, and there's no
  // `ttlSeconds` property on EditorData to poke - it's a closure argument to
  // createPresenceStore. Build a presence store directly instead, against
  // the same redis-memory-server instance. A nice side effect of the module
  // split: presence is testable in isolation, with no lock/memory-backend
  // machinery in the way.
  describe('presence store internals (short TTL, direct construction)', () => {
    test('expiry-driven disappearance and explicit removal', async () => {
      const redisClient = new Redis({host, port});
      const store = createPresenceStore(redisClient, 'presence-test-3:', 1, new editorDataMemory.EditorData());
      const docId = 'doc-expiry';

      try {
        await store.addPresence(ctx, docId, 'conn-expiring', JSON.stringify({id: 'uid-1', connectionId: 'conn-expiring', view: false}));
        let seen = await store.getPresence(ctx, docId, []);
        expect(seen).toHaveLength(1);

        await new Promise(r => setTimeout(r, 1300));
        seen = await store.getPresence(ctx, docId, []);
        expect(seen).toHaveLength(0);

        await store.addPresence(ctx, docId, 'conn-explicit', JSON.stringify({id: 'uid-2', connectionId: 'conn-explicit', view: false}));
        await store.removePresence(ctx, docId, 'conn-explicit');
        seen = await store.getPresence(ctx, docId, []);
        expect(seen).toHaveLength(0);
      } finally {
        await store.removePresenceDocument(ctx, docId);
        await redisClient.quit();
      }
    }, 10000);

    test('getDocumentPresenceExpired sharded sweep finds all due documents once and does not re-claim them', async () => {
      const redisClient = new Redis({host, port});
      const store = createPresenceStore(redisClient, 'presence-test-4:', 1, new editorDataMemory.EditorData());
      const docIds = ['doc-sweep-1', 'doc-sweep-2', 'doc-sweep-3', 'doc-sweep-4', 'doc-sweep-5'];

      try {
        for (const docId of docIds) {
          await store.addPresence(ctx, docId, 'conn-1', JSON.stringify({id: 'uid-1', connectionId: 'conn-1', view: false}));
        }

        await new Promise(r => setTimeout(r, 1300));
        const expired = await store.getDocumentPresenceExpired(Date.now());
        const expiredDocIds = expired.filter(([tenant]) => tenant === ctx.tenant).map(([, docId]) => docId);
        expect(docIds.every(d => expiredDocIds.includes(d))).toBe(true);

        const expiredAgain = await store.getDocumentPresenceExpired(Date.now());
        expect(expiredAgain).toHaveLength(0);
      } finally {
        for (const docId of docIds) {
          await store.removePresenceDocument(ctx, docId);
        }
        await redisClient.quit();
      }
    }, 10000);

    // Regression: updatePresence used to return nothing regardless of
    // whether there was actually anything to refresh, so a caller had no
    // way to tell "refreshed" apart from "silently found nothing" - which
    // matters once WRITE_SCRIPT's native TTL backstop means an entry can
    // now genuinely disappear between heartbeats, not just via explicit
    // removal.
    test('updatePresence reports false when there is nothing to refresh, true when there is', async () => {
      const redisClient = new Redis({host, port});
      const store = createPresenceStore(redisClient, 'presence-test-5:', 1, new editorDataMemory.EditorData());
      const docId = 'doc-update-missing';

      try {
        const neverAdded = await store.updatePresence(ctx, docId, 'conn-never-added');
        expect(neverAdded).toBe(false);

        await store.addPresence(ctx, docId, 'conn-expired', JSON.stringify({id: 'uid-1', connectionId: 'conn-expired', view: false}));
        await new Promise(r => setTimeout(r, 3500)); // past ttlSeconds=1's native TTL backstop (3x)
        const afterExpiry = await store.updatePresence(ctx, docId, 'conn-expired');
        expect(afterExpiry).toBe(false);

        await store.addPresence(ctx, docId, 'conn-live', JSON.stringify({id: 'uid-2', connectionId: 'conn-live', view: false}));
        const refreshed = await store.updatePresence(ctx, docId, 'conn-live');
        expect(refreshed).toBe(true);
      } finally {
        await store.removePresenceDocument(ctx, docId);
        await redisClient.quit();
      }
    }, 10000);
  });

  // Simulated deterministically by making the Redis call itself throw,
  // rather than racing a real broken TCP connection against ioredis's async
  // connect/retry machinery (flaky, and not what this test is about - it's
  // about the catch branch in getPresence, not connection timing).
  test('getPresence fails open (falls back to the memory backend) when Redis errors', async () => {
    const instance = new editorDataRedisLocks.EditorData();
    await instance.connect();
    const originalZrangebyscore = instance._redis.zrangebyscore.bind(instance._redis);
    instance._redis.zrangebyscore = async () => {
      throw new Error('simulated Redis error');
    };

    try {
      const docId = 'doc-failopen';
      const fakeConnections = [{docId, id: 'sock-1', user: {id: 'uid-1', view: false}, isCloseCoAuthoring: false}];
      const hvals = await instance.getPresence(ctx, docId, fakeConnections);
      expect(Array.isArray(hvals)).toBe(true);
      expect(hvals).toHaveLength(1);
      // The fallback is only this replica's local view, not a confirmed
      // reading - DocsCoServer.js's hasEditors() relies on this marker to
      // avoid treating a Redis error as "confirmed zero editors" and
      // releasing the WOPI lock / wiping the save-lock keys out from under
      // an editor genuinely active on a different replica.
      expect(hvals.presenceUnknown).toBe(true);
    } finally {
      instance._redis.zrangebyscore = originalZrangebyscore;
      await instance.close();
    }
  });

  // A GET-then-SET across two round trips would let a refresh land after the
  // connection was already removed, bringing it back for the full TTL -
  // this drives that exact interleaving, not just the non-conflicting case.
  // updatePresence must refresh only if the HASH field still exists.
  test('a concurrent remove is not undone by a late updatePresence', async () => {
    const instance = new editorDataRedisLocks.EditorData();
    await instance.connect();
    const docId = 'doc-update-race';
    const connId = 'conn-racing';

    try {
      await instance.addPresence(ctx, docId, connId, JSON.stringify({id: 'uid-1', connectionId: connId, view: false}));
      await instance.removePresence(ctx, docId, connId);
      // updatePresence arriving AFTER the removal - simulates a refresh
      // sweep (expireDoc, DocsCoServer.js) that started before the
      // disconnect and completes after it.
      await instance.updatePresence(ctx, docId, connId);

      const seen = await instance.getPresence(ctx, docId, []);
      expect(seen).toHaveLength(0);
    } finally {
      await instance.cleanDocumentOnExit(ctx, docId);
      await instance.close();
    }
  });

  // A Redis error here must not throw uncaught - it would otherwise make a
  // Redis outage turn into documents being unopenable, not just un-synced.
  test('addPresence/removePresence/removePresenceDocument fail open on a Redis error', async () => {
    const instance = new editorDataRedisLocks.EditorData();
    await instance.connect();
    const docId = 'doc-write-failopen';
    const originalWrite = instance._redis.presenceWriteScript.bind(instance._redis);
    const originalRemove = instance._redis.presenceRemoveScript.bind(instance._redis);
    const originalDel = instance._redis.del.bind(instance._redis);
    instance._redis.presenceWriteScript = async () => {
      throw new Error('simulated Redis error');
    };
    instance._redis.presenceRemoveScript = async () => {
      throw new Error('simulated Redis error');
    };
    // removePresenceDocument's happy path calls redis.del directly, not
    // either script above - that has to fail too for its fail-open branch
    // to actually be exercised.
    instance._redis.del = async () => {
      throw new Error('simulated Redis error');
    };

    // Fail-open means delegating to the memory backend, not just "didn't
    // throw" - a swallowed error with no delegate call would pass a bare
    // resolves.not.toThrow() just as well.
    const memoryAdd = jest.spyOn(instance._memory, 'addPresence');
    const memoryRemove = jest.spyOn(instance._memory, 'removePresence');
    const memoryRemoveDoc = jest.spyOn(instance._memory, 'removePresenceDocument');

    try {
      const userInfo = JSON.stringify({id: 'uid-1', connectionId: 'conn-1', view: false});
      await instance.addPresence(ctx, docId, 'conn-1', userInfo);
      expect(memoryAdd).toHaveBeenCalledWith(ctx, docId, 'conn-1', userInfo);

      await instance.removePresence(ctx, docId, 'conn-1');
      expect(memoryRemove).toHaveBeenCalledWith(ctx, docId, 'conn-1');

      await instance.removePresenceDocument(ctx, docId);
      expect(memoryRemoveDoc).toHaveBeenCalledWith(ctx, docId);
    } finally {
      instance._redis.presenceWriteScript = originalWrite;
      instance._redis.presenceRemoveScript = originalRemove;
      instance._redis.del = originalDel;
      memoryAdd.mockRestore();
      memoryRemove.mockRestore();
      memoryRemoveDoc.mockRestore();
      await instance.close();
    }
  });

  // cleanDocumentOnExit fires whenever the last EDITOR leaves (hasEditors
  // ignores viewers), so it must not delete presence itself - a viewer can
  // still be legitimately connected. The "presence is genuinely empty"
  // cleanup is a separate call, gated on an empty getPresence result.
  test('cleanDocumentOnExit leaves presence untouched (a still-connected viewer keeps their entry)', async () => {
    const instance = new editorDataRedisLocks.EditorData();
    await instance.connect();
    const docId = 'doc-clean-exit-presence';
    const viewerConnId = 'conn-viewer';

    try {
      await instance.addPresence(ctx, docId, viewerConnId, JSON.stringify({id: 'uid-viewer', connectionId: viewerConnId, view: true}));
      await instance.cleanDocumentOnExit(ctx, docId);

      const seen = await instance.getPresence(ctx, docId, []);
      expect(seen).toHaveLength(1);
    } finally {
      await instance.removePresenceDocument(ctx, docId);
      await instance.close();
    }
  });

  // Regression: writeAndTrack/updatePresence used to call docExpSweep.track
  // as a separate round trip from the write itself, with no try/catch of
  // its own - a failure there fell the whole call back to the memory
  // backend, wrongly implying the write never reached Redis at all.
  test('a sweep-tracking failure after a successful write does not fall addPresence back to the memory backend', async () => {
    const instance = new editorDataRedisLocks.EditorData();
    await instance.connect();
    const docId = 'doc-sweep-track-failure';
    const connId = 'conn-1';
    const userInfo = JSON.stringify({id: 'uid-1', connectionId: connId, view: false});

    const memoryAdd = jest.spyOn(instance._memory, 'addPresence');
    // docExpSweep's internal command name for this store - see
    // editorDataRedisShardedSweep.js's `${commandNamePrefix}Track`, and
    // createPresenceStore's own 'presenceDocExp' prefix.
    const originalTrack = instance._redis.presenceDocExpTrack.bind(instance._redis);
    instance._redis.presenceDocExpTrack = async () => {
      throw new Error('simulated sweep-tracking error');
    };

    try {
      await instance.addPresence(ctx, docId, connId, userInfo);
      expect(memoryAdd).not.toHaveBeenCalled();

      // Confirm the write genuinely landed in Redis via a raw read, not
      // getPresence - getPresence would itself fail open if this were
      // broken in a different way, which would mask the real assertion.
      const raw = new Redis({host, port});
      const hashKey = buildKey('presence-test:presence:', ctx.tenant, docId);
      const stored = await raw.hget(hashKey, connId);
      await raw.quit();
      expect(stored).toBe(userInfo);
    } finally {
      instance._redis.presenceDocExpTrack = originalTrack;
      memoryAdd.mockRestore();
      await instance.removePresenceDocument(ctx, docId);
      await instance.close();
    }
  });
});
