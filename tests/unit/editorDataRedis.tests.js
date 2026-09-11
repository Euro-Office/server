const {describe, test, expect, beforeAll, afterAll, jest} = require('@jest/globals');
const path = require('path');
// Only installed under DocService/node_modules, not at this level - same
// explicit-path convention tests/integration uses for Common-only packages.
const {RedisMemoryServer} = require('../../DocService/node_modules/redis-memory-server');
const Redis = require('../../DocService/node_modules/ioredis');
const {buildKey} = require('../../DocService/sources/editorDataRedisKeys');

// Runs against a real Redis via redis-memory-server (in-memory, no manual
// container) so this is a true unit test, not an integration test needing infra.
describe('editorDataRedis', () => {
  let redisServer;
  let host;
  let port;
  let editorDataMemory;
  let editorDataRedis;
  const ctx = {tenant: 'default'};

  beforeAll(async () => {
    redisServer = new RedisMemoryServer();
    host = await redisServer.getHost();
    port = await redisServer.getPort();

    // config's env override must be set before the first require of any
    // module that itself requires('config') - config caches its parsed
    // result on first load, so this can't move into a test() body.
    process.env.NODE_CONFIG_DIR = process.env.EO_CONFIG_DIR || path.join(__dirname, '..', '..', 'Common', 'config');
    process.env.NODE_CONFIG = JSON.stringify({
      log: {options: {replaceConsole: false}},
      services: {
        CoAuthoring: {
          redis: {host, port, prefix: 'locks-test:'}
        }
      }
    });

    editorDataMemory = require('../../DocService/sources/editorDataMemory');
    editorDataRedis = require('../../DocService/sources/editorDataRedis');
  }, 30000);

  afterAll(async () => {
    await redisServer.stop();
  });

  // Two independent in-process EditorData instances model "replica A" and
  // "replica B" directly - no timing race needed to prove the point, since
  // each backend either does or doesn't share state between instances.
  describe('cross-replica discrimination (interface-level negative control)', () => {
    test('two separate memory-backend instances share no state: both independently grant the same lock', async () => {
      const replicaA = new editorDataMemory.EditorData();
      const replicaB = new editorDataMemory.EditorData();
      const docId = 'doc-mem-iface';

      const grantedA = await replicaA.lockSave(ctx, docId, 'uid-1', 60);
      const grantedB = await replicaB.lockSave(ctx, docId, 'uid-2', 60);

      expect(grantedA).toBe(true);
      expect(grantedB).toBe(true);
    });

    test('redis backend correctly serializes the same call pattern across two replica instances pointed at the same Redis', async () => {
      const replicaA = new editorDataRedis.EditorData();
      const replicaB = new editorDataRedis.EditorData();
      await replicaA.connect();
      await replicaB.connect();
      const docId = 'doc-redis-iface';

      try {
        const grantedA = await replicaA.lockSave(ctx, docId, 'uid-1', 60);
        const grantedB = await replicaB.lockSave(ctx, docId, 'uid-2', 60);

        expect(grantedA).toBe(true);
        expect(grantedB).toBe(false);
      } finally {
        await replicaA.cleanDocumentOnExit(ctx, docId);
        await replicaA.close();
        await replicaB.close();
      }
    });
  });

  describe('lock semantics', () => {
    test('same owner re-asserting before expiry refreshes the TTL (reentrant), a different owner is denied until genuine expiry', async () => {
      const replicaA = new editorDataRedis.EditorData();
      const replicaB = new editorDataRedis.EditorData();
      await replicaA.connect();
      await replicaB.connect();
      const docId = 'doc-reentrancy';
      // Long enough that the reassert-then-expire timing below has a real
      // margin on a loaded CI runner, short enough to keep the test fast;
      // correctness doesn't depend on the real 60s value.
      const ttlSeconds = 2;
      const raw = new Redis({host, port});

      try {
        const first = await replicaA.lockSave(ctx, docId, 'uid-1', ttlSeconds);
        expect(first).toBe(true);

        const key = buildKey('locks-test:lockSave:', ctx.tenant, docId);
        await new Promise(resolve => setTimeout(resolve, 500)); // let some of the TTL elapse first
        const ttlBeforeReassert = await raw.pttl(key);

        const reassert = await replicaA.lockSave(ctx, docId, 'uid-1', ttlSeconds);
        expect(reassert).toBe(true);
        const ttlAfterReassert = await raw.pttl(key);
        // Confirms re-asserting actually refreshes the TTL, not just returns
        // true without re-SETting.
        expect(ttlAfterReassert).toBeGreaterThan(ttlBeforeReassert);

        const otherDenied = await replicaB.lockSave(ctx, docId, 'uid-2', ttlSeconds);
        expect(otherDenied).toBe(false);

        await new Promise(resolve => setTimeout(resolve, ttlSeconds * 1000 + 500));

        const afterExpiry = await replicaB.lockSave(ctx, docId, 'uid-2', ttlSeconds);
        expect(afterExpiry).toBe(true);

        // Client must abort via !lockRes, not assume it still owns the lock.
        const originalOwnerNowDenied = await replicaA.lockSave(ctx, docId, 'uid-1', ttlSeconds);
        expect(originalOwnerNowDenied).toBe(false);
      } finally {
        await raw.quit();
        await replicaA.cleanDocumentOnExit(ctx, docId);
        await replicaA.close();
        await replicaB.close();
      }
    }, 10000);

    test('key-collision avoidance via encodeURIComponent for (tenant, docId) pairs that collide when naively joined', async () => {
      const replicaA = new editorDataRedis.EditorData();
      await replicaA.connect();
      const raw = new Redis({host, port});

      try {
        // "a:b" + ":" + "c"  ===  "a" + ":" + "b:c"  ===  "a:b:c" if naively joined.
        await replicaA.lockSave({tenant: 'a:b'}, 'c', 'owner-A', 5);
        await replicaA.lockSave({tenant: 'a'}, 'b:c', 'owner-B', 5);

        const keys = await raw.keys('locks-test:lockSave:{a*');
        expect(keys.length).toBe(2);

        const decoded = keys.map(k => {
          // Strip the prefix and the cluster hash-tag braces buildKey adds.
          const rest = k.replace('locks-test:lockSave:{', '').replace(/}$/, '');
          const [encTenant, encDocId] = rest.split(':', 2);
          return {tenant: decodeURIComponent(encTenant), docId: decodeURIComponent(encDocId)};
        });
        expect(decoded).toContainEqual({tenant: 'a:b', docId: 'c'});
        expect(decoded).toContainEqual({tenant: 'a', docId: 'b:c'});
      } finally {
        await raw.del(buildKey('locks-test:lockSave:', 'a:b', 'c'), buildKey('locks-test:lockSave:', 'a', 'b:c'));
        await raw.quit();
        await replicaA.close();
      }
    });

    test('unlockSave/unlockAuth/lockAuth outcomes', async () => {
      const replica = new editorDataRedis.EditorData();
      await replica.connect();
      const docId = 'doc-unlock-coverage';

      try {
        const emptyUnlock = await replica.unlockSave(ctx, docId, 'uid-1');
        expect(emptyUnlock).toBe(2); // EMPTY: never locked

        await replica.lockSave(ctx, docId, 'uid-1', 5);
        const wrongOwnerUnlock = await replica.unlockSave(ctx, docId, 'uid-2');
        expect(wrongOwnerUnlock).toBe(0); // LOCKED: not released
        const stillHeld = await replica.lockSave(ctx, docId, 'uid-2', 5);
        expect(stillHeld).toBe(false); // confirms the failed unlock didn't release it

        const ownerUnlock = await replica.unlockSave(ctx, docId, 'uid-1');
        expect(ownerUnlock).toBe(1); // UNLOCKED
        const reacquired = await replica.lockSave(ctx, docId, 'uid-2', 5);
        expect(reacquired).toBe(true); // genuinely free after a real unlock

        // lockAuth/unlockAuth use their own keyspace (lockAuth: prefix),
        // separate from lockSave's.
        const authGranted = await replica.lockAuth(ctx, docId, 'uid-3', 5);
        expect(authGranted).toBe(true);
        const saveStillHeld = await replica.lockSave(ctx, docId, 'uid-2', 5);
        expect(saveStillHeld).toBe(true); // lockSave/lockAuth don't interfere
        const authUnlock = await replica.unlockAuth(ctx, docId, 'uid-3');
        expect(authUnlock).toBe(1);
      } finally {
        await replica.cleanDocumentOnExit(ctx, docId);
        await replica.close();
      }
    });

    // Fail-closed on a Redis error, simulated deterministically by making
    // the underlying script call throw, rather than racing a real broken
    // connection against ioredis's async retry/timeout machinery.
    test('lockSave/lockAuth deny (not throw) and unlockSave reports LOCKED on a Redis error', async () => {
      const replica = new editorDataRedis.EditorData();
      await replica.connect();
      const docId = 'doc-fail-closed';

      const originalLockScript = replica._redis.saveLockScript.bind(replica._redis);
      const originalUnlockScript = replica._redis.saveUnlockScript.bind(replica._redis);
      replica._redis.saveLockScript = async () => {
        throw new Error('simulated Redis error');
      };
      replica._redis.saveUnlockScript = async () => {
        throw new Error('simulated Redis error');
      };

      try {
        await expect(replica.lockSave(ctx, docId, 'uid-1', 5)).resolves.toBe(false);
        await expect(replica.lockAuth(ctx, docId, 'uid-1', 5)).resolves.toBe(false);
        await expect(replica.unlockSave(ctx, docId, 'uid-1')).resolves.toBe(0);
      } finally {
        replica._redis.saveLockScript = originalLockScript;
        replica._redis.saveUnlockScript = originalUnlockScript;
        await replica.close();
      }
    });

    // Fail-closed above simulates a call that throws promptly. That only
    // matches reality because commandTimeout bounds how long a stalled call
    // (mid-failover, a network blip) can hang before it does - without it,
    // a stall blocks save/auth for every user on the document instead of
    // failing closed quickly. Pin the value directly since nothing else here
    // would notice it silently regressing to unbounded.
    test('commandTimeout is set on the Redis connection', async () => {
      const replica = new editorDataRedis.EditorData();
      await replica.connect();
      try {
        expect(replica._redis.options.commandTimeout).toBe(300);
      } finally {
        await replica.close();
      }
    });

    // buildKey (encodeURIComponent under the hood) throws on a lone UTF-16
    // surrogate, and a docId/tenant containing one is reachable from a
    // client message, not just a theoretical input. Regression for
    // buildKey previously running outside lock()/unlock()'s try block.
    test('a malformed-unicode docId denies the lock rather than throwing', async () => {
      const replica = new editorDataRedis.EditorData();
      await replica.connect();
      const malformedDocId = '\ud800'; // lone high surrogate, no matching low surrogate

      try {
        await expect(replica.lockSave(ctx, malformedDocId, 'uid-1', 5)).resolves.toBe(false);
        await expect(replica.lockAuth(ctx, malformedDocId, 'uid-1', 5)).resolves.toBe(false);
        await expect(replica.unlockSave(ctx, malformedDocId, 'uid-1')).resolves.toBe(0); // LOCKED, not a throw
      } finally {
        await replica.close();
      }
    });
  });

  describe('cleanup and health', () => {
    // Both keys always carry their own PX expiry from LOCK_SCRIPT, so a
    // failed DEL just means they self-expire late rather than being
    // removed early - safe to swallow. Regression for cleanup() previously
    // having no try/catch at all, unlike lock()/unlock() beside it.
    test('cleanDocumentOnExit does not throw when the lock-cleanup DEL fails', async () => {
      const replica = new editorDataRedis.EditorData();
      await replica.connect();
      const docId = 'doc-cleanup-fail';
      const originalDel = replica._redis.del.bind(replica._redis);
      replica._redis.del = async () => {
        throw new Error('simulated Redis error');
      };

      try {
        await expect(replica.cleanDocumentOnExit(ctx, docId)).resolves.toBeUndefined();
      } finally {
        replica._redis.del = originalDel;
        await replica.close();
      }
    });

    // Regression for isConnected()/healthCheck() being unable to ever turn
    // true on an idle replica under the shipped iooptions.lazyConnect:
    // true default, since nothing but real lock/presence traffic used to
    // touch _redis at all.
    test('isConnected()/healthCheck() become true after connect(), with no lock/presence traffic', async () => {
      const replica = new editorDataRedis.EditorData();
      await replica.connect();

      try {
        await new Promise((resolve, reject) => {
          if (replica.isConnected()) {
            resolve();
            return;
          }
          replica._redis.once('ready', resolve);
          replica._redis.once('error', reject);
        });
        await expect(replica.healthCheck()).resolves.toBe(true);
      } finally {
        await replica.close();
      }
    }, 10000);
  });

  // ioredis emits connection failures as 'error' events, not as command
  // rejections, so they never reach the stores' catch blocks. With no
  // listener it prints "[ioredis] Unhandled error event" and a stack to
  // stderr once per retry - unthrottled, and outside the logger.
  describe('connection errors', () => {
    test('are listened for, so ioredis does not print them itself', async () => {
      const instance = new editorDataRedis.EditorData();
      try {
        expect(instance._redis.listenerCount('error')).toBeGreaterThan(0);
      } finally {
        await instance.close();
      }
    }, 10000);

    test('are throttled like command failures rather than logged per retry', async () => {
      const operationContext = require('../../Common/sources/operationContext');
      const spy = jest.spyOn(operationContext.global.logger, 'error').mockImplementation(() => {});
      const instance = new editorDataRedis.EditorData();
      try {
        for (let i = 0; i < 40; i++) {
          instance._redis.emit('error', new Error('ECONNREFUSED'));
        }
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        await instance.close();
      }
    }, 10000);
  });

  // ROUTES declares what the hand-written delegates below it do, so these
  // tests are what stops the two drifting: a method added to the interface
  // upstream and never exposed here produces no error at all, just a backend
  // that silently does not implement it.
  describe('routing table', () => {
    // Defined by hand because it has real behaviour, not delegation.
    const EXPLICIT = ['cleanDocumentOnExit'];
    const declared = () => [...Object.values(editorDataRedis.ROUTES).flat(), ...editorDataRedis.NOT_PORTED, ...EXPLICIT];
    const interfaceArity = method => editorDataMemory.EditorData.prototype[method].length;

    test('accounts for every method of the interface it replaces', () => {
      const own = Object.getOwnPropertyNames(editorDataMemory.EditorData.prototype).filter(
        name => name !== 'constructor' && typeof editorDataMemory.EditorData.prototype[name] === 'function'
      );
      expect(declared().sort()).toEqual(own.sort());
    });

    test('claims no method twice, and none that does not exist', () => {
      const names = declared();
      expect(names.length).toBe(new Set(names).size);
      for (const name of names) {
        expect(typeof editorDataMemory.EditorData.prototype[name]).toBe('function');
      }
    });

    test('gives each implemented method the interface signature, and passes every argument on', async () => {
      const instance = new editorDataRedis.EditorData();
      try {
        for (const [store, methods] of Object.entries(editorDataRedis.ROUTES)) {
          for (const method of methods) {
            // Arity, because a hand-written delegate can silently drop a
            // trailing parameter - the one failure the generated form below
            // cannot have, and the reason these are worth writing out.
            expect(editorDataRedis.EditorData.prototype[method]).toHaveLength(interfaceArity(method));
            const args = Array.from({length: interfaceArity(method)}, (_, i) => `arg${i}`);
            const target = jest.spyOn(instance[store], method).mockReturnValue('routed');
            expect(instance[method](...args)).toBe('routed');
            expect(target).toHaveBeenCalledWith(...args);
            target.mockRestore();
          }
        }
      } finally {
        await instance.close();
      }
    }, 10000);

    test('passes the unported methods through to the memory backend untouched', async () => {
      const instance = new editorDataRedis.EditorData();
      try {
        for (const method of editorDataRedis.NOT_PORTED) {
          const args = Array.from({length: interfaceArity(method)}, (_, i) => `arg${i}`);
          const target = jest.spyOn(instance._memory, method).mockReturnValue('memory');
          expect(instance[method](...args)).toBe('memory');
          expect(target).toHaveBeenCalledWith(...args);
          target.mockRestore();
        }
      } finally {
        await instance.close();
      }
    }, 10000);
  });
});
