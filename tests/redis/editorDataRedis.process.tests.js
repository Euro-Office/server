'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {fork} = require('node:child_process');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const redis = require('../../DocService/node_modules/redis');
const utils = require('../../Common/sources/utils');
const memoryStorage = require('../../DocService/sources/editorDataMemory');
const redisBase = require('../../DocService/sources/editorDataRedis/base');
const {context} = require('./testHelpers');

const WORKER_PATH = path.join(__dirname, 'editorDataRedis.process.worker.js');
const DOCSERVICE_ROOT = path.resolve(__dirname, '../../DocService');
const REQUEST_TIMEOUT_MS = 10000;
const WAIT_TIMEOUT_MS = 5000;

function contextArgs(tenant, overrides = {}) {
  return {__type: 'context', tenant, overrides};
}

function snapshot(value) {
  return structuredClone(value);
}

function comparable(value) {
  if (value === undefined) {
    return {__undefined: true};
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return {__date: value.toISOString()};
  }
  if (Array.isArray(value)) {
    return value.map(comparable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, comparable(value[key])])
    );
  }
  return value;
}

function assertObservableEqual(actual, expected, message) {
  assert.equal(JSON.stringify(comparable(actual)), JSON.stringify(comparable(expected)), message);
}

function stablePresenceShape(values) {
  return values.map(value => JSON.stringify(comparable(JSON.parse(value)))).sort();
}

async function waitFor(scenario, operation, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() <= deadline) {
    lastValue = await operation();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${scenario} timed out; last value: ${JSON.stringify(lastValue)}`);
}

function redisOptions() {
  const redisConfig = config.get('services.CoAuthoring.redis');
  return redisBase.normalizeNodeOptions(redisConfig.get('options') || {}, undefined);
}

function createTopologyClient() {
  const redisConfig = config.get('services.CoAuthoring.redis');
  if (process.env.TEST_REDIS_SENTINEL === 'true') {
    return redis.createSentinel(redisBase.normalizeSentinelOptions(redisConfig.get('optionsSentinel') || {}, undefined));
  }
  if (process.env.TEST_REDIS_CLUSTER === 'true') {
    return redis.createCluster(redisBase.normalizeClusterOptions(redisConfig.get('optionsCluster') || {}));
  }
  return redis.createClient(redisOptions());
}

async function createRedisClient() {
  const client = createTopologyClient();
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function cleanupRedisClient(client, prefix) {
  for await (const keys of client.scanIterator({MATCH: `${prefix}*`, COUNT: 1000})) {
    for (let index = 0; index < keys.length; index += 100) {
      await Promise.all(keys.slice(index, index + 100).map(key => client.del(key)));
    }
  }
}

async function cleanupRedisPrefix(prefix) {
  const client = await createRedisClient();
  try {
    if (process.env.TEST_REDIS_CLUSTER === 'true') {
      for (const master of client.masters) {
        await cleanupRedisClient(master.client, prefix);
      }
    } else {
      await cleanupRedisClient(client, prefix);
    }
  } finally {
    await client.close();
  }
}

class ReplicaHarness {
  constructor(prefix) {
    this.prefix = prefix;
    this.children = new Map();
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.nextRequestId = 0;
  }

  async start() {
    const ready = await Promise.all(['replica-a', 'replica-b'].map(async replicaId => ({replicaId, message: await this.startReplica(replicaId)})));
    for (const {replicaId, message} of ready) {
      assert.equal(message.replicaId, replicaId, `process identity: worker announced the wrong replica for ${replicaId}`);
    }
    const pids = [...this.children.values()].map(child => child.pid);
    assert.equal(new Set(pids).size, 2, `process identity: expected two OS processes, got ${pids.join(', ')}`);
  }

  startReplica(replicaId) {
    const child = fork(WORKER_PATH, [], {
      cwd: DOCSERVICE_ROOT,
      env: {
        ...process.env,
        TEST_REDIS_PREFIX: this.prefix,
        TEST_REDIS_REPLICA_ID: replicaId
      },
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.children.set(replicaId, child);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child._testOutput = () => output.slice(-4000);
    child.on('message', message => this.handleMessage(replicaId, message));
    child.on('exit', (code, signal) => {
      const reason = `worker exited (code=${code}, signal=${signal})`;
      if (child._testReady) {
        clearTimeout(child._testReady.timer);
        child._testReady.reject(this.error('worker readiness', replicaId, `${reason}\n${child._testOutput()}`));
        delete child._testReady;
      }
      for (const [requestId, pending] of this.pending) {
        if (pending.replicaId === replicaId) {
          this.pending.delete(requestId);
          pending.reject(this.error(pending.scenario, replicaId, `${reason}\n${child._testOutput()}`));
        }
      }
      for (const waiter of this.eventWaiters.filter(item => item.replicaId === replicaId)) {
        waiter.reject(this.error(waiter.scenario, replicaId, `${reason}\n${child._testOutput()}`));
      }
      this.eventWaiters = this.eventWaiters.filter(item => item.replicaId !== replicaId);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this.error('worker readiness', replicaId, `timed out\n${child._testOutput()}`));
      }, REQUEST_TIMEOUT_MS);
      child._testReady = {resolve, reject, timer};
    });
  }

  handleMessage(replicaId, message) {
    if (message.type === 'ready') {
      if (this.children.get(replicaId)._testReady) {
        clearTimeout(this.children.get(replicaId)._testReady.timer);
        this.children.get(replicaId)._testReady.resolve(message);
        delete this.children.get(replicaId)._testReady;
      }
      return;
    }
    if (message.type === 'result' || message.type === 'shutdown-complete' || message.type === 'error') {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        if (message.type === 'error' && this.children.get(replicaId)._testReady) {
          const child = this.children.get(replicaId);
          clearTimeout(child._testReady.timer);
          child._testReady.reject(
            this.error('worker readiness', replicaId, message.error?.stack || message.error?.message || 'unknown worker error')
          );
          delete child._testReady;
        }
        return;
      }
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.type === 'error') {
        pending.reject(this.error(pending.scenario, replicaId, message.error?.stack || message.error?.message));
      } else {
        pending.resolve(message.value);
      }
      return;
    }
    this.events.push({replicaId, message});
    for (const waiter of [...this.eventWaiters]) {
      if (waiter.replicaId === replicaId && waiter.predicate(message)) {
        this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  error(scenario, replicaId, detail) {
    return new Error(`${scenario} [${replicaId}, pid=${this.children.get(replicaId)?.pid || 'unknown'}]: ${detail}`);
  }

  send(replicaId, message, scenario, expectedType) {
    const child = this.children.get(replicaId);
    const requestId = `${replicaId}:${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(this.error(scenario, replicaId, `timed out waiting for ${expectedType}\n${child?._testOutput?.() || ''}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {replicaId, scenario, timer, resolve, reject, expectedType});
      if (!child || !child.connected) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(this.error(scenario, replicaId, 'worker is not connected'));
        return;
      }
      child.send({...message, requestId}, error => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(this.error(scenario, replicaId, error.stack || error.message));
        }
      });
    });
  }

  request(replicaId, target, method, args, scenario) {
    return this.send(replicaId, {type: 'dispatch', target, method, args}, scenario, 'result');
  }

  controlledDispatchWithOptions(replicaId, target, method, args, scenario, options) {
    const request = this.send(replicaId, {type: 'dispatch', target, method, args, signalOnCommand: true, ...options}, scenario, 'result');
    return {request, requestId: `${replicaId}:${this.nextRequestId}`};
  }

  waitForEvent(replicaId, predicate, scenario, timeoutMs = REQUEST_TIMEOUT_MS) {
    for (const event of this.events) {
      if (event.replicaId === replicaId && predicate(event.message)) {
        return Promise.resolve(event.message);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter(item => item !== waiter);
        reject(this.error(scenario, replicaId, 'timed out waiting for worker event'));
      }, timeoutMs);
      const waiter = {replicaId, predicate, scenario, timer, resolve, reject};
      this.eventWaiters.push(waiter);
    });
  }

  async kill(replicaId, signal = 'SIGKILL') {
    const child = this.children.get(replicaId);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill(signal);
    await exited;
  }

  async shutdown() {
    await Promise.all(
      [...this.children].map(async ([replicaId, child]) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        const shutdown = this.send(replicaId, {type: 'shutdown'}, 'worker shutdown', 'shutdown-complete');
        await shutdown.catch(() => {});
        if (child.exitCode === null && child.signalCode === null) {
          await this.kill(replicaId, 'SIGTERM');
        }
      })
    );
  }
}

async function runTrace(call, ctx) {
  const result = {};
  const lockDoc = 'differential-lock';
  result.lockFirst = await call('replica-a', 'data', 'lockSave', [ctx, lockDoc, 'owner-a', 5]);
  result.lockOther = await call('replica-b', 'data', 'lockSave', [ctx, lockDoc, 'owner-b', 5]);
  result.lockReentrant = await call('replica-b', 'data', 'lockSave', [ctx, lockDoc, 'owner-a', 5]);
  result.unlockWrong = await call('replica-a', 'data', 'unlockSave', [ctx, lockDoc, 'owner-b']);
  result.unlockOwner = await call('replica-b', 'data', 'unlockSave', [ctx, lockDoc, 'owner-a']);
  result.unlockEmpty = await call('replica-a', 'data', 'unlockSave', [ctx, lockDoc, 'owner-a']);

  const locksDoc = 'differential-object-locks';
  await call('replica-a', 'data', 'addLocks', [ctx, locksDoc, {alpha: {owner: 'a', version: 1}}]);
  result.staleLocks = snapshot(await call('replica-b', 'data', 'getLocks', [ctx, locksDoc]));
  await call('replica-b', 'data', 'addLocks', [ctx, locksDoc, {alpha: {owner: 'b', version: 2}}]);
  result.lockConflict = snapshot(await call('replica-b', 'data', 'addLocksNX', [ctx, locksDoc, {alpha: {owner: 'c'}, beta: {owner: 'b'}}]));
  await call('replica-a', 'data', 'removeLocks', [ctx, locksDoc, result.staleLocks]);
  result.locksAfterStaleRemoval = snapshot(await call('replica-b', 'data', 'getLocks', [ctx, locksDoc]));

  const messageDoc = 'differential-messages';
  await call('replica-a', 'data', 'addMessage', [ctx, messageDoc, {from: 'a', id: 1}]);
  await call('replica-b', 'data', 'addMessage', [ctx, messageDoc, {from: 'b', id: 2}]);
  result.messages = snapshot(await call('replica-a', 'data', 'getMessages', [ctx, messageDoc]));

  const savedDoc = 'differential-saved';
  await call('replica-a', 'data', 'setSaved', [ctx, savedDoc, 'saved']);
  result.savedRead = await call('replica-b', 'data', 'getdelSaved', [ctx, savedDoc]);
  result.savedEmpty = await call('replica-a', 'data', 'getdelSaved', [ctx, savedDoc]);

  const forceDoc = 'differential-force-save';
  await call('replica-a', 'data', 'setForceSave', [ctx, forceDoc, 100, 5, 'https://example.test', {change: 1}, {convert: 1}]);
  result.forceBefore = snapshot(await call('replica-b', 'data', 'getForceSave', [ctx, forceDoc]));
  result.forceStarted = snapshot(await call('replica-b', 'data', 'checkAndStartForceSave', [ctx, forceDoc]));
  result.forceStartedAgain = await call('replica-a', 'data', 'checkAndStartForceSave', [ctx, forceDoc]);
  result.forceStale = await call('replica-a', 'data', 'checkAndSetForceSave', [ctx, forceDoc, 99, 5, false, true, {stale: true}]);
  result.forceEnded = snapshot(await call('replica-b', 'data', 'checkAndSetForceSave', [ctx, forceDoc, 100, 5, false, true, {convert: 2}]));
  result.forceFinal = snapshot(await call('replica-a', 'data', 'getForceSave', [ctx, forceDoc]));

  const timerDoc = 'differential-timer';
  await call('replica-a', 'data', 'addForceSaveTimerNX', [ctx, timerDoc, 1]);
  await call('replica-b', 'data', 'addForceSaveTimerNX', [ctx, timerDoc, Date.now() + 60000]);
  result.timerClaim = await call('replica-b', 'data', 'getForceSaveTimer', [Date.now()]);
  result.timerEmpty = await call('replica-a', 'data', 'getForceSaveTimer', [Date.now()]);

  await call('replica-a', 'stat', 'addPresenceUniqueUser', [ctx, 'user', 300, {version: 1}]);
  await call('replica-b', 'stat', 'addPresenceUniqueUser', [ctx, 'user', 400, {version: 2}]);
  result.uniqueUser = snapshot(await call('replica-a', 'stat', 'getPresenceUniqueUser', [ctx, 100]));
  const period = Date.UTC(2026, 0, 1);
  await call('replica-a', 'stat', 'addPresenceUniqueUsersOfMonth', [ctx, 'user', period, {version: 1}]);
  await call('replica-b', 'stat', 'addPresenceUniqueUsersOfMonth', [ctx, 'user', period, {version: 2}]);
  result.uniqueUsersOfMonth = snapshot(await call('replica-a', 'stat', 'getPresenceUniqueUsersOfMonth', [ctx]));
  result.notificationFirst = await call('replica-a', 'stat', 'lockNotification', [ctx, 'differential', 5]);
  result.notificationSecond = await call('replica-b', 'stat', 'lockNotification', [ctx, 'differential', 5]);
  return result;
}

function presenceConnection(docId, userId) {
  return {
    docId,
    id: `${userId}-connection`,
    user: {
      id: userId,
      idOriginal: userId,
      username: userId,
      indexUser: 0,
      view: false
    },
    isCloseCoAuthoring: false,
    encrypted: false
  };
}

async function runDocumentPresenceShapeDifferential(harness, memoryData) {
  const tenant = config.get('tenants.defaultTenant');
  const redisCtx = contextArgs(tenant);
  const memoryCtx = context(tenant);
  const docId = 'differential-presence-shape';
  const connections = [
    presenceConnection(docId, 'presence-user-b'),
    presenceConnection(docId, 'presence-user-a'),
    presenceConnection('other-document', 'ignored-user')
  ];
  const documentConnections = connections.filter(connection => connection.docId === docId);

  // Redis receives the same serialized connection info that DocsCoServer writes.
  // Memory intentionally receives the live connections instead; its presence write methods are no-ops.
  for (const connection of [...documentConnections].reverse()) {
    const info = utils.getConnectionInfoStr(connection);
    await harness.request(
      'replica-a',
      'data',
      'addPresence',
      [redisCtx, docId, connection.user.id, info],
      `presence shape write for ${connection.user.id}`
    );
  }

  const expected = stablePresenceShape(documentConnections.map(connection => utils.getConnectionInfoStr(connection)));
  const redisPresence = await harness.request('replica-a', 'data', 'getPresence', [redisCtx, docId], 'presence shape Redis read');
  const memoryPresence = await memoryData.getPresence(memoryCtx, docId, connections);

  assert.equal(
    JSON.stringify(stablePresenceShape(redisPresence)),
    JSON.stringify(expected),
    'Redis presence must preserve the connection-info shape'
  );
  assert.equal(
    JSON.stringify(stablePresenceShape(memoryPresence)),
    JSON.stringify(expected),
    'memory presence must expose the connection-info shape'
  );
  assert.equal(
    JSON.stringify(stablePresenceShape(redisPresence)),
    JSON.stringify(stablePresenceShape(memoryPresence)),
    'Redis and memory presence shapes differ'
  );
}

async function runCrossProcessRedisScenarios(harness) {
  // These scenarios intentionally remain Redis-only: they cover persistence, expiry,
  // concurrent removal, and document cleanup across independent processes.
  const ctx = contextArgs('cross-process-tenant');
  const info = JSON.stringify({id: 'presence-user', replica: 'replica-a'});
  await harness.request('replica-a', 'data', 'addPresence', [ctx, 'presence-document', 'presence-user', info], 'presence write from replica-a');
  assertObservableEqual(
    await harness.request('replica-b', 'data', 'getPresence', [ctx, 'presence-document'], 'presence read from replica-b'),
    [info],
    'presence written by replica-a must be visible to replica-b'
  );
  await harness.request('replica-b', 'data', 'updatePresence', [ctx, 'presence-document', 'presence-user'], 'presence refresh from replica-b');
  await harness.request('replica-b', 'data', 'removePresence', [ctx, 'presence-document', 'presence-user'], 'presence removal from replica-b');
  assertObservableEqual(
    await harness.request('replica-a', 'data', 'getPresence', [ctx, 'presence-document'], 'presence read after removal'),
    [],
    'presence removal must cross the process boundary'
  );

  const expiringContext = contextArgs('cross-process-tenant', {'services.CoAuthoring.expire.presence': 1});
  await harness.request('replica-a', 'data', 'addPresence', [expiringContext, 'expiring-document', 'expiring-user', info], 'expiring presence write');
  await waitFor(
    'presence expiration visible from replica-b',
    () => harness.request('replica-b', 'data', 'getPresence', [expiringContext, 'expiring-document'], 'presence expiration read'),
    value => value.length === 0
  );

  const lockDoc = 'cross-process-lock';
  const lockResults = await Promise.all([
    harness.request('replica-a', 'data', 'lockSave', [ctx, lockDoc, 'owner-a', 5], 'save-lock race replica-a'),
    harness.request('replica-b', 'data', 'lockSave', [ctx, lockDoc, 'owner-b', 5], 'save-lock race replica-b')
  ]);
  assert.equal(lockResults.filter(Boolean).length, 1, `save-lock race must have one winner: ${JSON.stringify(lockResults)}`);
  const winner = lockResults[0] ? 'owner-a' : 'owner-b';
  assert.equal(
    await harness.request('replica-b', 'data', 'unlockSave', [ctx, lockDoc, winner === 'owner-a' ? 'owner-b' : 'owner-a'], 'wrong save-lock release'),
    0,
    'a non-owner must not release a save lock'
  );
  assert.equal(await harness.request('replica-a', 'data', 'unlockSave', [ctx, lockDoc, winner], 'owner save-lock release'), 1);
  assert.equal(await harness.request('replica-b', 'data', 'unlockSave', [ctx, lockDoc, winner], 'empty save-lock release'), 2);

  const expiringLock = 'cross-process-expiring-lock';
  assert.equal(
    await harness.request('replica-a', 'data', 'lockAuth', [expiringContext, expiringLock, 'old-owner', 1], 'expiring auth-lock write'),
    true
  );
  assert.equal(await harness.request('replica-b', 'data', 'unlockAuth', [expiringContext, expiringLock, 'new-owner'], 'wrong auth-lock release'), 0);
  await waitFor(
    'auth lock expiration visible from replica-b',
    () => harness.request('replica-b', 'data', 'lockAuth', [expiringContext, expiringLock, 'new-owner', 1], 'auth-lock expiration retry'),
    value => value === true
  );

  const raceNotification = await Promise.all([
    harness.request('replica-a', 'stat', 'lockNotification', [ctx, 'race-notification', 5], 'notification mutex replica-a'),
    harness.request('replica-b', 'stat', 'lockNotification', [ctx, 'race-notification', 5], 'notification mutex replica-b')
  ]);
  assert.equal(raceNotification.filter(Boolean).length, 1, `notification mutex must have one winner: ${JSON.stringify(raceNotification)}`);

  const messageDoc = 'cross-process-messages';
  await Promise.all(
    Array.from({length: 20}, (_, index) =>
      harness.request(
        index % 2 === 0 ? 'replica-a' : 'replica-b',
        'data',
        'addMessage',
        [ctx, messageDoc, {id: index, writer: index % 2 === 0 ? 'a' : 'b'}],
        `message write ${index}`
      )
    )
  );
  const messages = await harness.request('replica-b', 'data', 'getMessages', [ctx, messageDoc], 'cross-process message read');
  assert.equal(messages.length, 20, 'cross-process messages must not be duplicated or lost');
  assert.deepEqual(new Set(messages.map(message => message.id)), new Set(Array.from({length: 20}, (_, index) => index)));

  const savedDoc = 'cross-process-saved';
  await harness.request('replica-a', 'data', 'setSaved', [ctx, savedDoc, 'saved'], 'cross-process saved write');
  const savedReads = await Promise.all([
    harness.request('replica-a', 'data', 'getdelSaved', [ctx, savedDoc], 'saved getdel replica-a'),
    harness.request('replica-b', 'data', 'getdelSaved', [ctx, savedDoc], 'saved getdel replica-b')
  ]);
  assert.equal(savedReads.filter(value => value === 'saved').length, 1, `saved state must be consumed once: ${JSON.stringify(savedReads)}`);
  assert.equal(savedReads.filter(value => value === null).length, 1, `saved state must be empty for the other reader: ${JSON.stringify(savedReads)}`);

  const forceContext = contextArgs('cross-process-tenant', {'services.CoAuthoring.expire.forcesave': 10});
  const forceDoc = 'cross-process-force-save';
  await harness.request(
    'replica-a',
    'data',
    'setForceSave',
    [forceContext, forceDoc, 200, 8, 'https://example.test', {change: 'a'}, {convert: 'initial'}],
    'force-save write from replica-a'
  );
  assertObservableEqual(
    await harness.request('replica-b', 'data', 'getForceSave', [forceContext, forceDoc], 'force-save read from replica-b'),
    {
      time: 200,
      index: 8,
      baseUrl: 'https://example.test',
      changeInfo: {change: 'a'},
      convertInfo: {convert: 'initial'},
      started: false,
      ended: false
    },
    'force-save state must cross the process boundary'
  );
  const starts = await Promise.all([
    harness.request('replica-a', 'data', 'checkAndStartForceSave', [forceContext, forceDoc], 'force-save start replica-a'),
    harness.request('replica-b', 'data', 'checkAndStartForceSave', [forceContext, forceDoc], 'force-save start replica-b')
  ]);
  assert.equal(starts.filter(Boolean).length, 1, `force-save start must have one winner: ${JSON.stringify(starts)}`);
  assert.equal(starts.filter(value => value === undefined).length, 1, `force-save start loser must be undefined: ${JSON.stringify(starts)}`);
  assert.equal(
    await harness.request(
      'replica-a',
      'data',
      'checkAndSetForceSave',
      [forceContext, forceDoc, 199, 8, false, true, {stale: true}],
      'stale force-save update'
    ),
    undefined,
    'stale force-save update must not overwrite state'
  );
  const ended = await harness.request(
    'replica-b',
    'data',
    'checkAndSetForceSave',
    [forceContext, forceDoc, 200, 8, false, true, {convert: 'final'}],
    'force-save update from replica-b'
  );
  assert.equal(ended.ended, true);
  assertObservableEqual((await harness.request('replica-a', 'data', 'getForceSave', [forceContext, forceDoc], 'force-save final read')).convertInfo, {
    convert: 'final'
  });

  const timerDoc = 'cross-process-timer';
  await harness.request('replica-a', 'data', 'addForceSaveTimerNX', [ctx, timerDoc, 1], 'force-save timer first write');
  await harness.request('replica-b', 'data', 'addForceSaveTimerNX', [ctx, timerDoc, Date.now() + 60000], 'force-save timer competing write');
  assertObservableEqual(
    await harness.request('replica-b', 'data', 'getForceSaveTimer', [Date.now()], 'force-save timer claim from replica-b'),
    [['cross-process-tenant', timerDoc]],
    'force-save timer must preserve the first write across processes'
  );
  assertObservableEqual(
    await harness.request('replica-a', 'data', 'getForceSaveTimer', [Date.now()], 'force-save timer empty read'),
    [],
    'timer claim must not duplicate'
  );

  const activeDoc = 'cross-process-presence-cleanup';
  await harness.request('replica-a', 'data', 'addPresence', [ctx, activeDoc, 'active', info], 'active presence write');
  await harness.request('replica-b', 'data', 'removePresenceDocument', [ctx, activeDoc], 'active presence document removal');
  assertObservableEqual(await harness.request('replica-a', 'data', 'getPresence', [ctx, activeDoc], 'active presence remains'), [info]);
  await harness.request('replica-b', 'data', 'removePresence', [ctx, activeDoc, 'active'], 'active presence removal');
  await harness.request('replica-a', 'data', 'removePresenceDocument', [ctx, activeDoc], 'empty presence document removal');
  assertObservableEqual(await harness.request('replica-b', 'data', 'getPresence', [ctx, activeDoc], 'empty presence read'), []);
}

async function runCrashScenario(harness) {
  const ctx = contextArgs('crash-tenant', {'services.CoAuthoring.expire.presence': 1});
  const requestId = `replica-a:${harness.nextRequestId + 1}`;
  const workerCommand = harness.waitForEvent(
    'replica-a',
    message => message.type === 'redis-command-started' && message.requestId === requestId,
    'controlled crash command dispatch'
  );
  const committedCommand = harness.waitForEvent(
    'replica-a',
    message => message.type === 'redis-command-committed' && message.requestId === requestId,
    'controlled crash command commit'
  );
  const crashRequest = harness
    .controlledDispatchWithOptions(
      'replica-a',
      'data',
      'addPresence',
      [ctx, 'crash-document', 'crashed-user', JSON.stringify({id: 'crashed-user'})],
      'controlled crash presence write',
      {holdAfterCommand: true}
    )
    .request.catch(error => error);
  await workerCommand;
  await committedCommand;
  await harness.kill('replica-a', 'SIGKILL');
  await crashRequest;

  const presence = await waitFor(
    'remaining replica view after replica-a SIGKILL',
    () => harness.request('replica-b', 'data', 'getPresence', [ctx, 'crash-document'], 'remaining replica crash view'),
    value => value.length === 1
  );
  assertObservableEqual(presence, [JSON.stringify({id: 'crashed-user'})]);
  assert.equal(await harness.request('replica-b', 'data', 'ping', [], 'remaining replica ping after SIGKILL'), 'PONG');
  assert.equal(
    await harness.request('replica-b', 'data', 'lockSave', [ctx, 'after-crash-lock', 'survivor', 1], 'remaining replica lock after SIGKILL'),
    true
  );
  assert.equal(
    await harness.request('replica-b', 'data', 'unlockSave', [ctx, 'after-crash-lock', 'survivor'], 'remaining replica unlock after SIGKILL'),
    1
  );
  await harness.request('replica-b', 'data', 'removePresence', [ctx, 'crash-document', 'crashed-user'], 'remaining replica crash presence removal');
  await harness.request('replica-b', 'data', 'removePresenceDocument', [ctx, 'crash-document'], 'remaining replica crash document cleanup');
  assertObservableEqual(
    await harness.request('replica-b', 'data', 'getPresence', [ctx, 'crash-document'], 'remaining replica crash cleanup view'),
    []
  );
}

describe('editorDataRedis independent-process behavior', () => {
  test('shares state across two replicas and matches the in-memory oracle for successful operations', async () => {
    const prefix = `${process.env.TEST_REDIS_PREFIX}process-suite:${process.pid}:${randomUUID()}:`;
    const harness = new ReplicaHarness(prefix);
    const memoryData = new memoryStorage.EditorData();
    const memoryStat = new memoryStorage.EditorStat();
    try {
      await harness.start();
      const redisTrace = await runTrace(
        (replicaId, target, method, args) => harness.request(replicaId, target, method, args, `differential ${target}.${method}`),
        contextArgs('differential-tenant')
      );
      const memoryTrace = await runTrace(
        (_replicaId, target, method, args) =>
          (target === 'data' ? memoryData : memoryStat)[method](
            ...args.map(value => (value?.__type === 'context' ? context(value.tenant, value.overrides) : value))
          ),
        contextArgs('differential-tenant')
      );
      assertObservableEqual(redisTrace, memoryTrace, 'Redis and memory observable results differ');
      await runCrossProcessRedisScenarios(harness);
    } finally {
      await Promise.all([harness.shutdown(), memoryData.close(), memoryStat.close()]);
      await cleanupRedisPrefix(prefix);
    }
  }, 40000);

  test('compares document presence shape with the memory connection oracle', async () => {
    const prefix = `${process.env.TEST_REDIS_PREFIX}process-presence-shape:${process.pid}:${randomUUID()}:`;
    const harness = new ReplicaHarness(prefix);
    const memoryData = new memoryStorage.EditorData();
    try {
      await harness.start();
      await runDocumentPresenceShapeDifferential(harness, memoryData);
    } finally {
      await Promise.all([harness.shutdown(), memoryData.close()]);
      await cleanupRedisPrefix(prefix);
    }
  }, 30000);

  test('allows only one replica to start a command-path force-save after a reset interleaving', async () => {
    const prefix = `${process.env.TEST_REDIS_PREFIX}process-force-save-race:${process.pid}:${randomUUID()}:`;
    const harness = new ReplicaHarness(prefix);
    const ctx = contextArgs('force-save-race-tenant', {'services.CoAuthoring.expire.forcesave': 10});
    const docId = 'command-path-force-save-race';
    const time = 300;
    const index = 11;
    try {
      await harness.start();
      await harness.request(
        'replica-a',
        'data',
        'setForceSave',
        [ctx, docId, time, index, 'https://example.test', {change: 'initial'}, {convert: 'initial'}],
        'force-save race record creation'
      );

      const resetByReplicaA = await harness.request(
        'replica-a',
        'data',
        'checkAndSetForceSave',
        [ctx, docId, time, index, false, false, null],
        'force-save race reset by replica-a'
      );
      assert.equal(resetByReplicaA.time, time);
      assert.equal(resetByReplicaA.index, index);
      assert.equal(resetByReplicaA.started, false);
      assert.equal(resetByReplicaA.ended, false);

      const startedByReplicaA = await harness.request(
        'replica-a',
        'data',
        'checkAndStartForceSave',
        [ctx, docId],
        'force-save race start by replica-a'
      );
      assert.ok(startedByReplicaA, 'replica-a must be allowed to start the force-save');
      assert.equal(startedByReplicaA.time, time);
      assert.equal(startedByReplicaA.index, index);
      assert.equal(startedByReplicaA.started, true);

      const resetByReplicaB = await harness.request(
        'replica-b',
        'data',
        'checkAndSetForceSave',
        [ctx, docId, time, index, false, false, null],
        'force-save race reset by replica-b'
      );

      const startedByReplicaB = await harness.request(
        'replica-b',
        'data',
        'checkAndStartForceSave',
        [ctx, docId],
        'force-save race start by replica-b'
      );
      const starts = [startedByReplicaA, startedByReplicaB];
      assert.equal(starts.filter(value => value !== undefined).length, 1, `force-save race must have one winner: ${JSON.stringify(starts)}`);
      assert.equal(startedByReplicaB, undefined, 'replica-b must not start a force-save reset by replica-b');
      assert.equal(resetByReplicaB, undefined, 'replica-b must not reset an active force-save');
    } finally {
      await harness.shutdown();
      await cleanupRedisPrefix(prefix);
    }
  }, 30000);

  test('keeps a committed force-save started when the start response is lost', async () => {
    const prefix = `${process.env.TEST_REDIS_PREFIX}process-force-save-response-loss:${process.pid}:${randomUUID()}:`;
    const harness = new ReplicaHarness(prefix);
    const ctx = contextArgs('force-save-response-loss-tenant', {'services.CoAuthoring.expire.forcesave': 10});
    const docId = 'force-save-response-loss';
    const time = 301;
    const index = 12;
    try {
      await harness.start();
      await harness.request(
        'replica-a',
        'data',
        'setForceSave',
        [ctx, docId, time, index, 'https://example.test', {change: 'initial'}, {convert: 'initial'}],
        'force-save response-loss record creation'
      );

      const requestId = `replica-a:${harness.nextRequestId + 1}`;
      const committedCommand = harness.waitForEvent(
        'replica-a',
        message => message.type === 'redis-command-committed' && message.requestId === requestId,
        'force-save response-loss command commit'
      );
      const startRequest = harness
        .controlledDispatchWithOptions('replica-a', 'data', 'checkAndStartForceSave', [ctx, docId], 'force-save response-loss start', {
          holdAfterCommand: true
        })
        .request.catch(error => error);

      await committedCommand;
      await harness.kill('replica-a', 'SIGKILL');
      const lostResponse = await startRequest;
      assert.equal(lostResponse instanceof Error, true, 'the start response must be lost with the killed replica');

      const stateAfterLostResponse = await harness.request('replica-b', 'data', 'getForceSave', [ctx, docId], 'force-save response-loss state read');
      assert.equal(stateAfterLostResponse.time, time);
      assert.equal(stateAfterLostResponse.index, index);
      assert.equal(stateAfterLostResponse.started, true);
      assert.equal(stateAfterLostResponse.ended, false);
      assert.equal(
        await harness.request('replica-b', 'data', 'checkAndStartForceSave', [ctx, docId], 'force-save response-loss retry'),
        undefined,
        'a committed force-save must not be started again after its response is lost'
      );
    } finally {
      await harness.shutdown();
      await cleanupRedisPrefix(prefix);
    }
  }, 30000);

  test('keeps the remaining replica usable after SIGKILL during a controlled Redis write', async () => {
    const prefix = `${process.env.TEST_REDIS_PREFIX}process-crash:${process.pid}:${randomUUID()}:`;
    const harness = new ReplicaHarness(prefix);
    try {
      await harness.start();
      await runCrashScenario(harness);
    } finally {
      await harness.shutdown();
      await cleanupRedisPrefix(prefix);
    }
  }, 30000);
});
