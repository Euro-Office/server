'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {EDITOR_INDEX_SHARD_COUNT} = require('../../DocService/sources/editorDataRedis/redisKeys');
const {CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT, CLEAN_DOCUMENT_SCRIPT} = require('../../DocService/sources/editorDataRedis/scripts');
const {context} = require('./testHelpers');

describe('editorDataRedis failure policy', () => {
  let data;
  let stat;

  beforeEach(() => {
    data = new EditorData();
    stat = new EditorStat();
  });

  afterEach(async () => {
    await Promise.all([data.close(), stat.close()]);
  });

  test('fails closed when acquiring a save or auth lock fails', async () => {
    data._eval = async () => {
      throw new Error('Redis unavailable');
    };
    stat._command = async () => {
      throw new Error('Redis unavailable');
    };
    const ctx = context('lock-acquire-failure');

    assert.equal(await data.lockSave(ctx, 'document', 'user', 5), false);
    assert.equal(await data.lockAuth(ctx, 'document', 'user', 5), false);
    assert.equal(await stat.lockNotification(ctx, 'notification', 5), false);
  });

  test('fails closed when releasing a save or auth lock fails', async () => {
    data._eval = async () => {
      throw new Error('Redis unavailable');
    };
    const ctx = context('lock-release-failure');

    assert.equal(await data.unlockSave(ctx, 'document', 'user'), commonDefines.c_oAscUnlockRes.Locked);
    assert.equal(await data.unlockAuth(ctx, 'document', 'user'), commonDefines.c_oAscUnlockRes.Locked);
  });

  test('does not convert presence, lock, message, or force-save read failures into empty values', async () => {
    data._eval = async () => {
      throw new Error('Redis unavailable');
    };
    data._command = async () => {
      throw new Error('Redis unavailable');
    };
    const ctx = context('reader-failure');

    await assert.rejects(data.getPresence(ctx, 'document'), /Redis unavailable/);
    await assert.rejects(data.getLocks(ctx, 'document'), /Redis unavailable/);
    await assert.rejects(data.getMessages(ctx, 'document'), /Redis unavailable/);
    await assert.rejects(data.getForceSave(ctx, 'document'), /Redis unavailable/);
    for (const expired of [data.getDocumentPresenceExpired(Date.now()), data.getForceSaveTimer(Date.now())]) {
      const batch = await expired;
      assert.deepEqual(batch, []);
      assert.equal(batch.hasShardFailure, true);
      assert.equal(batch.shardFailures.length, EDITOR_INDEX_SHARD_COUNT);
      assert.ok(batch.shardFailures.every(failure => failure.message === 'Redis unavailable'));
    }
  });

  test.each([CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT, CLEAN_DOCUMENT_SCRIPT])(
    'does not continue destructive document cleanup after a Redis failure at step %#',
    async failingScript => {
      let evalCalls = 0;
      data._eval = async script => {
        evalCalls++;
        if (script === failingScript) {
          throw new Error('Redis unavailable');
        }
        assert.equal(script, CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT);
        return 'OK';
      };
      const ctx = context('cleanup-failure');

      await assert.rejects(data.cleanDocumentOnExit(ctx, 'document'), /Redis unavailable/);
      assert.equal(evalCalls, failingScript === CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT ? 1 : 2);
    }
  );

  test.each([
    undefined,
    null,
    [],
    [0, '123'],
    [0, '123', undefined],
    [1, undefined],
    [4, '123'],
    [null, '123', '456'],
    [true, '123'],
    ['invalid', '123']
  ])('fails closed when document cleanup returns an invalid result: %j', async result => {
    let syncIndexCalls = 0;
    data._eval = async () => result;
    data._syncPresenceIndex = async () => {
      syncIndexCalls++;
    };

    assert.equal(await data.cleanDocumentOnExit(context('cleanup-invalid-result'), 'document'), false);
    assert.equal(syncIndexCalls, 0);
  });

  test('does not attempt force-save index cleanup after document deletion succeeds but index cleanup fails', async () => {
    let evalCalls = 0;
    data._eval = async script => {
      evalCalls++;
      if (script === CLAIM_FORCE_SAVE_TIMER_CLEANUP_SCRIPT) {
        return 'OK';
      }
      if (script === CLEAN_DOCUMENT_SCRIPT) {
        return [1, '123'];
      }
      throw new Error('force-save index cleanup should not be attempted');
    };
    data._syncPresenceIndex = async () => {
      throw new Error('Redis unavailable');
    };
    const ctx = context('cleanup-index-failure');

    await assert.rejects(data.cleanDocumentOnExit(ctx, 'document'), /Redis unavailable/);
    assert.equal(evalCalls, 2);
  });
});
