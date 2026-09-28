'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
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
    await assert.rejects(data.getDocumentPresenceExpired(Date.now()), /Redis unavailable/);
    await assert.rejects(data.getForceSaveTimer(Date.now()), /Redis unavailable/);
  });

  test('does not continue destructive document cleanup after a Redis failure', async () => {
    let evalCalls = 0;
    data._eval = async () => {
      evalCalls++;
      throw new Error('Redis unavailable');
    };
    const ctx = context('cleanup-failure');

    await assert.rejects(data.cleanDocumentOnExit(ctx, 'document'), /Redis unavailable/);
    assert.equal(evalCalls, 1);
  });

  test('does not attempt force-save index cleanup after document deletion succeeds but index cleanup fails', async () => {
    let evalCalls = 0;
    let commandCalls = 0;
    data._eval = async () => {
      evalCalls++;
      if (evalCalls === 1) {
        return [1, '123'];
      }
      throw new Error('Redis unavailable');
    };
    data._command = async () => {
      commandCalls++;
      throw new Error('force-save index cleanup should not be attempted');
    };
    const ctx = context('cleanup-index-failure');

    await assert.rejects(data.cleanDocumentOnExit(ctx, 'document'), /Redis unavailable/);
    assert.equal(evalCalls, 2);
    assert.equal(commandCalls, 0);
  });
});
