'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');

function context(tenant) {
  return {
    tenant,
    getCfg(_path, fallback) {
      return fallback;
    }
  };
}

describe('editorDataRedis edge cases', () => {
  let data;
  let stat;

  beforeEach(() => {
    data = new EditorData();
    stat = new EditorStat();
  });

  afterEach(async () => {
    await Promise.all([data.close(), stat.close()]);
  });

  test('empty lock updates are no-ops and return the existing lock state', async () => {
    const ctx = context('empty-lock-input');
    const docId = 'document';

    await data.addLocks(ctx, docId, {});
    assert.deepEqual(await data.getLocks(ctx, docId), {});
    assert.deepEqual(await data.addLocksNX(ctx, docId, {}), {lockConflict: {}, allLocks: {}});
    await data.removeLocks(ctx, docId, {});
    assert.deepEqual(await data.getLocks(ctx, docId), {});
  });

  test('save locks are isolated by tenant even when document IDs match', async () => {
    const first = context('lock-tenant-one');
    const second = context('lock-tenant-two');

    assert.equal(await data.lockSave(first, 'same-document', 'owner-one', 5), true);
    assert.equal(await data.lockSave(second, 'same-document', 'owner-two', 5), true);
    assert.equal(await data.unlockSave(first, 'same-document', 'owner-two'), 0);
    assert.equal(await data.unlockSave(first, 'same-document', 'owner-one'), 1);
    assert.equal(await data.unlockSave(second, 'same-document', 'owner-two'), 1);
  });

  test('cleaning a document removes its force-save timer as well as document data', async () => {
    const ctx = context('force-save-timer-cleanup');
    const docId = 'document';
    const dueLater = Date.now() + 60000;

    await data.addMessage(ctx, docId, {message: true});
    await data.addForceSaveTimerNX(ctx, docId, dueLater);
    await data.cleanDocumentOnExit(ctx, docId);

    assert.deepEqual(await data.getMessages(ctx, docId), []);
    assert.deepEqual(await data.getForceSaveTimer(Date.now() + 120000), []);
  });

  test('updating a unique user replaces its information without duplicating the user', async () => {
    const ctx = context('unique-user-update');

    await stat.addPresenceUniqueUser(ctx, 'user', 200000, {version: 1});
    await stat.addPresenceUniqueUser(ctx, 'user', 300000, {version: 2});

    assert.deepEqual(await stat.getPresenceUniqueUser(ctx, 100000), [
      {userid: 'user', expire: new Date(300000000), version: 2}
    ]);
  });

  test('updating a monthly unique user keeps one entry for the period', async () => {
    const ctx = context('monthly-user-update');
    const period = Date.UTC(2026, 0, 1);

    await stat.addPresenceUniqueUsersOfMonth(ctx, 'user', period, {version: 1});
    await stat.addPresenceUniqueUsersOfMonth(ctx, 'user', period, {version: 2});

    assert.deepEqual(await stat.getPresenceUniqueUsersOfMonth(ctx), {
      '2026-01-01T00:00:00.000Z': {user: {version: 2}}
    });
  });

  test('editor connection statistics ignore malformed samples and retain valid data', async () => {
    stat._command = async () => [
      'not-json',
      JSON.stringify({notData: true}),
      JSON.stringify({data: {time: 100, edit: 1, liveview: 2, view: 3}})
    ];

    assert.deepEqual(await stat.getEditorConnections(context('malformed-samples')), [{time: 100, edit: 1, liveview: 2, view: 3}]);
  });

  test('monthly statistics return an empty object when no periods are active', async () => {
    stat._command = async command => (command[0] === 'ZRANGEBYSCORE' ? [] : 0);

    assert.deepEqual(await stat.getPresenceUniqueUsersOfMonth(context('empty-month')), {});
  });
});
