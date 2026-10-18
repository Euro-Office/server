'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, jest, test} = require('@jest/globals');

const canvasservice = require('../../DocService/sources/canvasservice');
const commonDefines = require('../../Common/sources/commondefines');
const constants = require('../../Common/sources/constants');
const docsCoServer = require('../../DocService/sources/DocsCoServer');
const memoryStorage = require('../../DocService/sources/editorDataMemory');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const storage = require('../../Common/sources/storage/storage-base');
const taskResult = require('../../DocService/sources/taskresult');

function command(overrides = {}) {
  return new commonDefines.InputCommand({
    id: 'saved-state-document',
    userid: 'user-1',
    useractionid: 'action-1',
    userindex: 1,
    status_info: constants.NO_ERROR,
    status_info_in: 12,
    savekey: 'save-key',
    outputpath: 'output.docx',
    ...overrides
  });
}

function context() {
  return {
    tenant: 'saved-state-tenant',
    getCfg(_path, fallback) {
      return fallback;
    },
    logger: {
      debug() {},
      error() {},
      warn() {}
    }
  };
}

describe('canvasservice saved-state handling', () => {
  let spies;

  beforeEach(() => {
    spies = [];
    const mock = (object, method, implementation) => {
      const spy = jest.spyOn(object, method).mockImplementation(implementation);
      spies.push(spy);
      return spy;
    };

    mock(taskResult, 'select', async () => [
      {
        callback: 'https://callback.example.test/save',
        baseurl: 'https://storage.example.test',
        status: commonDefines.FileStatus.SaveVersion,
        status_info: 12,
        last_open_date: null
      }
    ]);
    mock(taskResult, 'updateIf', async () => ({affectedRows: 1}));
    mock(sqlBase.UserCallback.prototype, 'getCallbackByUserIndex', () => 'https://callback.example.test/save');
    mock(storage, 'listObjects', async () => []);
    mock(storage, 'getObject', async () => Buffer.from('{}'));
    mock(storage, 'getSignedUrl', async () => 'https://storage.example.test/signed');
    mock(docsCoServer, 'getEditorsCountPromise', async () => 0);
    mock(docsCoServer.editorData, 'getForceSave', async () => null);
    mock(docsCoServer, 'sendServerRequest', async () => JSON.stringify({error: 0}));
    mock(docsCoServer, 'parseReplyData', () => ({error: commonDefines.c_oAscServerCommandErrors.NoError}));
  });

  afterEach(() => {
    for (const spy of spies.reverse()) {
      spy.mockRestore();
    }
  });

  test('reports a normal final save as successful with the in-memory saved-state backend', async () => {
    const ctx = context();
    const doc = command();
    const previousEditorData = docsCoServer.editorData;
    const editorData = new memoryStorage.EditorData();
    docsCoServer.editorData = editorData;

    const cleanDocumentOnExitPromise = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(undefined);
    const publish = jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    spies.push(cleanDocumentOnExitPromise, publish);

    try {
      const reply = await canvasservice.commandSfcCallback(ctx, doc, false, false);

      assert.equal(reply, JSON.stringify({error: 0}));
      assert.equal(cleanDocumentOnExitPromise.mock.calls.length, 1);
      assert.equal(cleanDocumentOnExitPromise.mock.calls[0][4], undefined);
      assert.equal(publish.mock.calls.length, 1);
      assert.equal(publish.mock.calls[0][1].type, commonDefines.c_oPublishType.updateVersion);
      assert.equal(publish.mock.calls[0][1].docId, doc.getDocId());
      assert.equal(publish.mock.calls[0][1].success, true);
    } finally {
      docsCoServer.editorData = previousEditorData;
    }
  });

  test.each([
    ['Redis failure', new Error('Redis unavailable')],
    ['unknown outcome', Object.assign(new Error('saved state unknown'), {code: 'EDITOR_DATA_SAVED_UNKNOWN'})]
  ])('does not clean up or report success when saved-state resolution fails: %s', async (_scenario, error) => {
    const cleanDocumentOnExitPromise = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockImplementation(async () => {
      throw new Error('cleanup must not be reached');
    });
    const cleanDocumentOnExit = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockImplementation(async () => {
      throw new Error('forgotten cleanup must not be reached');
    });
    const copyObject = jest.spyOn(storage, 'copyObject').mockImplementation(async () => {
      throw new Error('forgotten-file copy must not be reached');
    });
    const unlockWopiDoc = jest.spyOn(docsCoServer, 'unlockWopiDoc').mockImplementation(async () => {
      throw new Error('WOPI cleanup must not be reached');
    });
    const publish = jest.spyOn(docsCoServer, 'publish').mockImplementation(async () => {
      throw new Error('success publication must not be reached');
    });
    spies.push(cleanDocumentOnExitPromise, cleanDocumentOnExit, copyObject, unlockWopiDoc, publish);
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockRejectedValue(error);
    spies.push(docsCoServer.editorData.getdelSaved);

    await assert.rejects(canvasservice.commandSfcCallback(context(), command(), false, false), rejected => rejected === error);
    assert.equal(cleanDocumentOnExitPromise.mock.calls.length, 0);
    assert.equal(cleanDocumentOnExit.mock.calls.length, 0);
    assert.equal(copyObject.mock.calls.length, 0);
    assert.equal(unlockWopiDoc.mock.calls.length, 0);
    assert.equal(publish.mock.calls.length, 0);
  });

  test('does not acknowledge a claim when document cleanup fails', async () => {
    const cleanupError = new Error('document cleanup failed');
    const ctx = context();
    const getdelSaved = jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    const ackSaved = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    const cleanDocumentOnExitPromise = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockRejectedValue(cleanupError);
    spies.push(getdelSaved, ackSaved, cleanDocumentOnExitPromise);

    await assert.rejects(canvasservice.commandSfcCallback(ctx, command(), false, false), error => error === cleanupError);
    assert.equal(ackSaved.mock.calls.length, 0);
    assert.equal(cleanDocumentOnExitPromise.mock.calls.length, 1);
    assert.equal(cleanDocumentOnExitPromise.mock.calls[0][0], ctx);
    assert.equal(cleanDocumentOnExitPromise.mock.calls[0][1], 'saved-state-document');
    assert.equal(cleanDocumentOnExitPromise.mock.calls[0][2], true);
    assert.equal(cleanDocumentOnExitPromise.mock.calls[0][3], 1);
    assert.equal(cleanDocumentOnExitPromise.mock.calls[0][4], 'save-key');
  });

  test.each([
    ['conversion error', {status_info: constants.CONVERT_READ_FILE, savedValue: '0', encrypted: false}],
    ['encrypted save', {status_info: constants.NO_ERROR, savedValue: '0', encrypted: true}],
    ['missing output file', {status_info: constants.NO_ERROR, savedValue: '0', encrypted: false, missingFile: true}]
  ])('acknowledges a claimed saved state on the %s path', async (_scenario, options) => {
    const getdelSaved = jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue(options.savedValue);
    const ackSaved = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    spies.push(getdelSaved, ackSaved);
    if (options.missingFile) {
      const getSignedUrl = jest.spyOn(storage, 'getSignedUrl').mockResolvedValue(undefined);
      spies.push(getSignedUrl);
    }

    await canvasservice.commandSfcCallback(context(), command({status_info: options.status_info}), false, options.encrypted);

    assert.equal(getdelSaved.mock.calls.length, 1);
    assert.equal(ackSaved.mock.calls.length, 1);
    assert.equal(ackSaved.mock.calls[0][1], 'saved-state-document');
    assert.equal(ackSaved.mock.calls[0][2], 'save-key');
  });

  test('handles duplicate delivery of a task with the same saved-state claim', async () => {
    const ctx = context();
    const editorData = docsCoServer.editorData;
    await editorData.setSaved(ctx, 'saved-state-document', '1');
    const claimKey = editorData._docKeys(ctx, 'saved-state-document').savedClaim;
    const getdelSaved = jest.spyOn(editorData, 'getdelSaved');
    const ackSaved = jest.spyOn(editorData, 'ackSaved');
    const cleanDocumentOnExitPromise = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(undefined);
    const publish = jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    spies.push(getdelSaved, ackSaved, cleanDocumentOnExitPromise, publish);

    await canvasservice.commandSfcCallback(ctx, command(), false, false);
    assert.equal(await editorData._command(['HGET', claimKey, 'state']), 'resolved');
    await canvasservice.commandSfcCallback(ctx, command(), false, false);

    assert.equal(getdelSaved.mock.calls.length, 2);
    assert.equal(await getdelSaved.mock.results[0].value, '1');
    assert.equal(await getdelSaved.mock.results[1].value, null);
    assert.equal(ackSaved.mock.calls.length, 1);
    assert.equal(ackSaved.mock.calls[0][1], 'saved-state-document');
    assert.equal(ackSaved.mock.calls[0][2], 'save-key');
  });

  test('handles concurrent duplicate delivery through receiveTask', async () => {
    const ctx = context();
    const editorData = docsCoServer.editorData;
    const keys = editorData._docKeys(ctx, 'saved-state-document');
    await editorData._command(['DEL', keys.saved, keys.savedClaim]);
    await editorData.setSaved(ctx, 'saved-state-document', '1');

    const update = jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    const cleanDocumentOnExitPromise = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(undefined);
    const publish = jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    const ackSaved = jest.spyOn(editorData, 'ackSaved');
    spies.push(update, cleanDocumentOnExitPromise, publish, ackSaved);

    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant: ctx.tenant, docId: 'saved-state-document', userId: 'user-1'});
    task.setCmd(command({c: 'sfc'}));
    const encodedTask = JSON.stringify(task);
    const acknowledgements = [jest.fn(), jest.fn()];

    await Promise.all(acknowledgements.map(ack => canvasservice.receiveTask(encodedTask, ack)));

    assert.deepEqual(
      acknowledgements.map(ack => ack.mock.calls.length),
      [1, 1]
    );
    assert.equal(ackSaved.mock.calls.length, 2);
    assert.equal(ackSaved.mock.calls[0][2], 'save-key');
    assert.equal(ackSaved.mock.calls[1][2], 'save-key');
    assert.equal(cleanDocumentOnExitPromise.mock.calls.length, 2);
    assert.equal(cleanDocumentOnExitPromise.mock.calls[0][4], 'save-key');
    assert.equal(cleanDocumentOnExitPromise.mock.calls[1][4], 'save-key');
    assert.equal(publish.mock.calls.length, 2);
  });

  test.each([
    ['force-save read', 'getForceSave', new Error('Redis unavailable')],
    ['saved-state read', 'getdelSaved', new Error('Redis unavailable')],
    ['unknown saved state', 'getdelSaved', Object.assign(new Error('saved state unknown'), {code: 'EDITOR_DATA_SAVED_UNKNOWN'})]
  ])('persists a retry before acknowledging a failed %s, then completes the final save', async (_scenario, method, error) => {
    const row = {
      callback: 'https://callback.example.test/save',
      baseurl: 'https://storage.example.test',
      status: commonDefines.FileStatus.SaveVersion,
      status_info: 12
    };
    taskResult.select.mockResolvedValue([row]);
    taskResult.updateIf.mockImplementation(async (_ctx, update, mask) => {
      if (row.status !== mask.status || row.status_info !== mask.statusInfo) {
        return {affectedRows: 0};
      }
      row.status = update.status;
      row.status_info = update.statusInfo;
      return {affectedRows: 1};
    });
    const update = jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    const getdelSaved = jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    const ackSaved = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    const cleanup = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(true);
    const publish = jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    docsCoServer.editorData[method].mockRejectedValueOnce(error);
    let confirmRetry;
    const confirmed = new Promise(resolve => {
      confirmRetry = resolve;
    });
    let retryStarted;
    const started = new Promise(resolve => {
      retryStarted = resolve;
    });
    let delayedTask;
    const addDelayed = jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* (task, timeout) {
      delayedTask = new commonDefines.TaskQueueData(JSON.parse(JSON.stringify(task)));
      assert.ok(timeout > 0);
      retryStarted();
      yield confirmed;
    });
    const ack = jest.fn();
    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant: 'saved-state-tenant', docId: 'saved-state-document', userId: 'user-1'});
    task.setCmd(command({c: 'sfc'}));
    spies.push(update, getdelSaved, ackSaved, cleanup, publish, addDelayed);

    const processing = canvasservice.receiveTask(JSON.stringify(task), ack);
    // A failed implementation returns without scheduling anything. Race with
    // processing so that regression fails instead of waiting for the test timeout.
    await Promise.race([started, processing]);

    assert.equal(addDelayed.mock.calls.length, 1);
    assert.equal(row.status, commonDefines.FileStatus.UpdateVersion);
    assert.equal(ack.mock.calls.length, 0);
    assert.equal(cleanup.mock.calls.length, 0);
    assert.equal(ackSaved.mock.calls.length, 0);
    assert.equal(publish.mock.calls.length, 0);
    assert.equal(docsCoServer.sendServerRequest.mock.calls.length, method === 'getForceSave' ? 0 : 1);
    assert.equal(delayedTask.getCmd().getSaveKey(), 'save-key');
    assert.equal(delayedTask.getCmd().getStatusInfoIn(), 12);
    assert.equal(delayedTask.getCmd().getOutputPath(), 'output.docx');
    assert.equal(delayedTask.getCmd().getAttempt(), 1);
    assert.equal(delayedTask.getCtx().tenant, 'saved-state-tenant');

    confirmRetry();
    await processing;
    assert.equal(ack.mock.calls.length, 1);
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(delayedTask), retryAck);
    assert.equal(retryAck.mock.calls.length, 1);
    assert.equal(addDelayed.mock.calls.length, 1);
    assert.equal(cleanup.mock.calls.length, 1);
    assert.equal(cleanup.mock.calls[0][4], 'save-key');
    assert.equal(ackSaved.mock.calls.length, 1);
    assert.equal(ackSaved.mock.calls[0][2], 'save-key');
    assert.equal(publish.mock.calls.length, 1);
    assert.equal(publish.mock.calls[0][1].success, true);
  });

  test('leaves delivery unacknowledged when the retry cannot be persisted', async () => {
    const update = jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    docsCoServer.editorData.getForceSave.mockRejectedValue(new Error('Redis unavailable'));
    const addDelayed = jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* () {
      yield Promise.reject(new Error('queue unavailable'));
    });
    spies.push(update, addDelayed);
    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant: 'saved-state-tenant', docId: 'saved-state-document', userId: 'user-1'});
    task.setCmd(command({c: 'sfc'}));
    const ack = jest.fn();

    await canvasservice.receiveTask(JSON.stringify(task), ack);

    assert.equal(addDelayed.mock.calls.length, 1);
    assert.equal(ack.mock.calls.length, 0);
  });

  test('recovers a Redis claim whose reply was lost using the same save key', async () => {
    const ctx = {...context(), tenant: 'saved-state-lost-reply'};
    const editorData = docsCoServer.editorData;
    await editorData.setSaved(ctx, 'saved-state-document', '1');
    const claimKey = editorData._docKeys(ctx, 'saved-state-document').savedClaim;
    const originalGetdelSaved = editorData.getdelSaved.bind(editorData);
    const getdelSaved = jest.spyOn(editorData, 'getdelSaved').mockImplementationOnce(async (...args) => {
      await originalGetdelSaved(...args);
      throw new Error('Redis claim reply lost');
    });
    const ackSaved = jest.spyOn(editorData, 'ackSaved');
    const update = jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    const cleanup = jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(true);
    const publish = jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    let delayedTask;
    const addDelayed = jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* (task) {
      delayedTask = JSON.stringify(task);
      yield Promise.resolve();
    });
    spies.push(getdelSaved, ackSaved, update, cleanup, publish, addDelayed);
    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant: ctx.tenant, docId: 'saved-state-document', userId: 'user-1'});
    task.setCmd(command({c: 'sfc'}));
    const ack = jest.fn();

    await canvasservice.receiveTask(JSON.stringify(task), ack);

    assert.equal(ack.mock.calls.length, 1);
    assert.equal(addDelayed.mock.calls.length, 1);
    assert.equal(await editorData._command(['HGET', claimKey, 'state']), 'pending');
    assert.equal(cleanup.mock.calls.length, 0);
    assert.equal(ackSaved.mock.calls.length, 0);

    await canvasservice.receiveTask(delayedTask, ack);

    assert.equal(ack.mock.calls.length, 2);
    assert.deepEqual(
      Array.from(getdelSaved.mock.calls, call => call[2]),
      ['save-key', 'save-key']
    );
    assert.equal(cleanup.mock.calls.length, 1);
    assert.equal(ackSaved.mock.calls.length, 1);
    assert.equal(await editorData._command(['HGET', claimKey, 'state']), 'resolved');
    assert.equal(publish.mock.calls[0][1].success, true);
  });

  test('keeps retrying Redis failures after the HTTP retry limit with a capped backoff', async () => {
    const update = jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    docsCoServer.editorData.getForceSave.mockRejectedValue(new Error('Redis unavailable'));
    const addDelayed = jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* () {});
    spies.push(update, addDelayed);
    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant: 'saved-state-tenant', docId: 'saved-state-document', userId: 'user-1'});
    task.setCmd(command({c: 'sfc', attempt: 100}));
    const ack = jest.fn();

    await canvasservice.receiveTask(JSON.stringify(task), ack);

    assert.equal(addDelayed.mock.calls.length, 1);
    assert.equal(addDelayed.mock.calls[0][0].getCmd().getAttempt(), 101);
    assert.equal(addDelayed.mock.calls[0][1], 8000);
    assert.equal(ack.mock.calls.length, 1);
  });
});
