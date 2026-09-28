'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {describe, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

const describeIntegration = process.env.TEST_REDIS_FAILURE_CONTAINER ? describe : describe.skip;

describeIntegration('editorDataRedis real connection-failure policy', () => {
  test('fails closed for locks and rejects reads and destructive cleanup after Redis stops', async () => {
    const data = new EditorData();
    const testContext = context('real-redis-failure');

    try {
      await data.connect();
      data.redis.commandTimeoutMs = 1000;
      assert.equal(await data.ping(), 'PONG');
      execFileSync('docker', ['stop', process.env.TEST_REDIS_FAILURE_CONTAINER], {stdio: 'pipe'});

      await assert.rejects(data.ping());
      assert.equal(await data.lockSave(testContext, 'document', 'user', 5), false);
      assert.equal(await data.unlockSave(testContext, 'document', 'user'), commonDefines.c_oAscUnlockRes.Locked);
      await assert.rejects(data.getPresence(testContext, 'document'));
      await assert.rejects(data.cleanDocumentOnExit(testContext, 'document'));
    } finally {
      await data.close();
    }
  }, 15000);
});
