'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

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

  test('force-save transitions preserve opaque payloads and compare-and-set state', async () => {
    const ctx = context('force-save-payloads', {'services.CoAuthoring.expire.forcesave': 10});
    const docId = 'document';
    const changeInfo = {
      empty: [],
      nested: {empty: []},
      largeNumber: 123456789012345
    };
    const initialConvertInfo = {
      empty: [],
      nested: {empty: []},
      largeNumber: 123456789012345
    };

    await data.setForceSave(ctx, docId, 100, 5, 'https://example.test', changeInfo, initialConvertInfo);
    const key = data._docKeys(ctx, docId).forceSave;
    assert.ok((await data._command(['TTL', key])) > 0);

    const beforeStart = await data.getForceSave(ctx, docId);
    assert.deepEqual(beforeStart.changeInfo, changeInfo);
    assert.deepEqual(beforeStart.convertInfo, initialConvertInfo);
    assert.equal(beforeStart.started, false);
    assert.equal(beforeStart.ended, false);

    const started = await data.checkAndStartForceSave(ctx, docId);
    assert.deepEqual(started.changeInfo, changeInfo);
    assert.deepEqual(started.convertInfo, initialConvertInfo);
    assert.equal(started.started, true);
    assert.equal(started.ended, false);
    assert.ok((await data._command(['TTL', key])) > 0);
    assert.equal(await data.checkAndStartForceSave(ctx, docId), undefined);

    const stale = await data.checkAndSetForceSave(ctx, docId, 99, 5, false, true, {stale: true});
    assert.equal(stale, undefined);
    const afterStale = await data.getForceSave(ctx, docId);
    assert.deepEqual(afterStale.changeInfo, changeInfo);
    assert.deepEqual(afterStale.convertInfo, initialConvertInfo);
    assert.equal(afterStale.started, true);
    assert.equal(afterStale.ended, false);

    const endedConvertInfo = {empty: [], nested: {empty: []}, largeNumber: 123456789012345};
    const ended = await data.checkAndSetForceSave(ctx, docId, 100, 5, false, true, endedConvertInfo);
    assert.deepEqual(ended.changeInfo, changeInfo);
    assert.deepEqual(ended.convertInfo, endedConvertInfo);
    assert.equal(ended.started, false);
    assert.equal(ended.ended, true);
    assert.ok((await data._command(['TTL', key])) > 0);

    await data.checkAndSetForceSave(ctx, docId, 100, 5, false, false, null);
    const nullConvertInfo = await data.getForceSave(ctx, docId);
    assert.deepEqual(nullConvertInfo.changeInfo, changeInfo);
    assert.equal(nullConvertInfo.convertInfo, null);

    await data.checkAndSetForceSave(ctx, docId, 100, 5, false, false, undefined);
    const undefinedConvertInfo = await data.getForceSave(ctx, docId);
    assert.deepEqual(undefinedConvertInfo.changeInfo, changeInfo);
    assert.equal(undefinedConvertInfo.convertInfo, undefined);
    assert.equal(Object.hasOwn(undefinedConvertInfo, 'convertInfo'), true);

    const nullAndMissingDocId = 'null-and-missing';
    await data.setForceSave(ctx, nullAndMissingDocId, 101, 6, 'https://example.test', null, undefined);
    const nullAndMissing = await data.checkAndStartForceSave(ctx, nullAndMissingDocId);
    assert.equal(nullAndMissing.changeInfo, null);
    assert.equal(nullAndMissing.convertInfo, undefined);
    assert.equal(Object.hasOwn(nullAndMissing, 'changeInfo'), true);
    assert.equal(Object.hasOwn(nullAndMissing, 'convertInfo'), true);
  });

  test('updating a unique user replaces its information without duplicating the user', async () => {
    const ctx = context('unique-user-update');

    await stat.addPresenceUniqueUser(ctx, 'user', 200000, {version: 1});
    await stat.addPresenceUniqueUser(ctx, 'user', 300000, {version: 2});

    assert.deepEqual(await stat.getPresenceUniqueUser(ctx, 100000), [{userid: 'user', expire: new Date(300000000), version: 2}]);
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
    stat._command = async () => ['not-json', JSON.stringify({notData: true}), JSON.stringify({data: {time: 100, edit: 1, liveview: 2, view: 3}})];

    assert.deepEqual(await stat.getEditorConnections(context('malformed-samples')), [{time: 100, edit: 1, liveview: 2, view: 3}]);
  });

  test('monthly statistics return an empty object when no periods are active', async () => {
    stat._command = async command => (command[0] === 'ZRANGEBYSCORE' ? [] : 0);

    assert.deepEqual(await stat.getPresenceUniqueUsersOfMonth(context('empty-month')), {});
  });
});
