'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');

const constants = require('../../Common/sources/constants');
const commonDefines = require('../../Common/sources/commondefines');
const converterService = require('../../DocService/sources/converterservice');
const docsCoServer = require('../../DocService/sources/DocsCoServer');
const taskResult = require('../../DocService/sources/taskresult');
const {EditorData: MemoryEditorData} = require('../../DocService/sources/editorDataMemory');
const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

describe('DocsCoServer force-save command path', () => {
  let data;

  function forceSaveContext(name) {
    return {
      ...context(name),
      logger: {debug() {}, warn() {}, error() {}}
    };
  }

  async function setActiveForceSave(ctx, docId, time) {
    await data.setForceSave(ctx, docId, time, 12, 'https://example.test', {change: 'initial'}, {failed: true});
    assert.ok(await data.checkAndStartForceSave(ctx, docId));
  }

  function assertInProgressResult(result) {
    assert.equal(result.code, commonDefines.c_oAscServerCommandErrors.NoError);
    assert.equal(result.time, null);
    assert.equal(result.inProgress, true);
  }

  beforeEach(() => {
    data = new EditorData();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await data.close();
  });

  test('starts a normal editor force-save request', async () => {
    const ctx = forceSaveContext('docs-co-server-force-save-normal');
    const docId = 'document';

    jest.spyOn(taskResult, 'selectWithCache').mockResolvedValue([]);
    jest.spyOn(converterService, 'convertFromChanges').mockResolvedValue({err: constants.NO_ERROR});
    await data.setForceSave(ctx, docId, 400, 12, 'https://example.test', {change: 'initial'}, null);

    const result = await docsCoServer.startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Command);

    assert.equal(result.code, commonDefines.c_oAscServerCommandErrors.NoError);
    assert.equal(result.time, 400);
    assert.equal(result.inProgress, false);
    assert.equal((await data.getForceSave(ctx, docId)).started, true);
  });

  test('reports UnknownError when a competing command cannot reset an active force-save', async () => {
    const ctx = forceSaveContext('docs-co-server-force-save-command-active');
    const docId = 'document';

    await setActiveForceSave(ctx, docId, 401);

    const result = await docsCoServer.startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Command);

    assert.equal(result.code, commonDefines.c_oAscServerCommandErrors.UnknownError);
    assert.equal(result.time, null);
    assert.equal(result.inProgress, false);
  });

  test.each([
    ['Form', commonDefines.c_oAscForceSaveTypes.Form],
    ['Internal', commonDefines.c_oAscForceSaveTypes.Internal]
  ])('returns in-progress for an already-active %s force-save', async (_name, type) => {
    const ctx = forceSaveContext(`docs-co-server-force-save-${type}`);
    const docId = 'document';

    await setActiveForceSave(ctx, docId, 402 + type);

    const result = await docsCoServer.startForceSave(ctx, docId, type);

    assertInProgressResult(result);
  });

  test.each([
    ['Form', commonDefines.c_oAscForceSaveTypes.Form],
    ['Internal', commonDefines.c_oAscForceSaveTypes.Internal]
  ])('returns in-progress to the losing concurrent %s force-save request', async (_name, type) => {
    const ctx = forceSaveContext(`docs-co-server-force-save-concurrent-${type}`);
    const docId = 'document';

    const convertFromChanges = jest.spyOn(converterService, 'convertFromChanges').mockResolvedValue({err: constants.NO_ERROR});
    await data.setForceSave(ctx, docId, 403 + type, 12, 'https://example.test', {change: 'initial'}, {failed: true});

    const results = await Promise.all([docsCoServer.startForceSave(ctx, docId, type), docsCoServer.startForceSave(ctx, docId, type)]);
    const inProgressResults = results.filter(result => result.inProgress);
    const startedResults = results.filter(result => !result.inProgress && result.time !== null);

    assert.equal(inProgressResults.length, 1);
    assert.equal(inProgressResults[0].code, commonDefines.c_oAscServerCommandErrors.NoError);
    assert.equal(inProgressResults[0].time, null);
    assert.equal(startedResults.length, 1);
    assert.equal(startedResults[0].code, commonDefines.c_oAscServerCommandErrors.NoError);
    assert.equal(startedResults[0].time, 403 + type);
    assert.equal(convertFromChanges.mock.calls.length, 1);
  });

  test('allows only one concurrent Redis force-save start', async () => {
    const ctx = forceSaveContext('docs-co-server-force-save-concurrent');
    const docId = 'document';

    await data.setForceSave(ctx, docId, 404, 12, 'https://example.test', {change: 'initial'}, null);
    const starts = await Promise.all([data.checkAndStartForceSave(ctx, docId), data.checkAndStartForceSave(ctx, docId)]);

    assert.equal(starts.filter(Boolean).length, 1);
    assert.equal(starts.filter(value => value === undefined).length, 1);
  });

  test('keeps the in-memory force-save start contract', async () => {
    const memory = new MemoryEditorData();
    const ctx = forceSaveContext('docs-co-server-force-save-memory');
    const docId = 'document';

    await memory.setForceSave(ctx, docId, 405, 12, 'https://example.test', {change: 'initial'}, null);
    assert.ok(await memory.checkAndStartForceSave(ctx, docId));
    assert.equal(await memory.checkAndStartForceSave(ctx, docId), undefined);
  });

  test('keeps Redis errors distinct from an already-active force-save', async () => {
    const ctx = forceSaveContext('docs-co-server-force-save-error');
    const docId = 'document';

    await setActiveForceSave(ctx, docId, 406);
    assert.equal(await data.checkAndStartForceSave(ctx, docId), undefined);

    data._eval = async () => {
      throw new Error('Redis unavailable');
    };
    await assert.rejects(data.checkAndStartForceSave(ctx, docId), /Redis unavailable/);
  });

  test('rejects when the in-progress follow-up read fails', async () => {
    const ctx = forceSaveContext('docs-co-server-force-save-follow-up-error');
    const docId = 'document';
    const error = new Error('Redis unavailable while rereading force-save');

    await setActiveForceSave(ctx, docId, 407);

    const getForceSave = docsCoServer.editorData.getForceSave.bind(docsCoServer.editorData);
    let getForceSaveCalls = 0;
    jest.spyOn(docsCoServer.editorData, 'getForceSave').mockImplementation(async (...args) => {
      getForceSaveCalls++;
      if (2 === getForceSaveCalls) {
        throw error;
      }
      return getForceSave(...args);
    });

    await assert.rejects(docsCoServer.startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Form), actualError => actualError === error);
    assert.equal(getForceSaveCalls, 2);
  });
});
