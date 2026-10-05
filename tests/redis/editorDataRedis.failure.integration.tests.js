'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {describe, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

const describeIntegration = process.env.TEST_REDIS_FAILURE_CONTAINER ? describe : describe.skip;

function waitForEvent(emitter, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const onEvent = value => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`Redis client did not emit ${event} within ${timeoutMs}ms`));
    }, timeoutMs);
    emitter.once(event, onEvent);
  });
}

describeIntegration('editorDataRedis real connection-failure policy', () => {
  test('fails closed across concurrent subsystems and recovers after Redis restarts', async () => {
    const data = new EditorData();
    const stat = new EditorStat();
    const testContext = context('real-redis-failure');
    let stopped = false;

    try {
      await Promise.all([data.connect(), stat.connect()]);
      data.redis.commandTimeoutMs = 1000;
      stat.redis.commandTimeoutMs = 1000;
      assert.equal(await data.ping(), 'PONG');
      assert.equal(await stat.ping(), 'PONG');
      const reconnecting = waitForEvent(data.redis.client, 'reconnecting');
      execFileSync('docker', ['stop', process.env.TEST_REDIS_FAILURE_CONTAINER], {stdio: 'pipe'});
      stopped = true;
      await reconnecting;

      const duringFailure = await Promise.race([
        Promise.allSettled([data.ping(), stat.ping(), data.redis.command(['PING']), stat.redis.command(['PING'])]),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
      ]);
      assert.notEqual(duringFailure, 'timeout', 'Redis-backed subsystems remained queued after socket loss');
      assert.equal(duringFailure.length, 4);
      assert.ok(
        duringFailure.some(result => result.status === 'rejected'),
        'at least one command should observe Redis failure'
      );
      assert.equal(await data.lockSave(testContext, 'document', 'user', 5), false);
      assert.equal(await data.unlockSave(testContext, 'document', 'user'), commonDefines.c_oAscUnlockRes.Locked);
      await assert.rejects(data.getPresence(testContext, 'document'));
      await assert.rejects(data.cleanDocumentOnExit(testContext, 'document'));

      execFileSync('docker', ['start', process.env.TEST_REDIS_FAILURE_CONTAINER], {stdio: 'pipe'});
      stopped = false;
      data.redis._abortClient();
      stat.redis._abortClient();
      await Promise.all([data.connect(), stat.connect()]);
      await waitForPing(data);
      await waitForPing(stat);
      assert.equal(await data.ping(), 'PONG');
      assert.equal(await stat.ping(), 'PONG');
    } finally {
      if (stopped) {
        execFileSync('docker', ['start', process.env.TEST_REDIS_FAILURE_CONTAINER], {stdio: 'pipe'});
      }
      await Promise.all([data.close(), stat.close()]);
    }
  }, 30000);
});

async function waitForPing(store, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      if ((await store.ping()) === 'PONG') {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Redis did not recover within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}`);
}
