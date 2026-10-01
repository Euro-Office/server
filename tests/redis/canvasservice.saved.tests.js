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

function command() {
  return new commonDefines.InputCommand({
    id: 'saved-state-document',
    userid: 'user-1',
    useractionid: 'action-1',
    userindex: 1,
    status_info: constants.NO_ERROR,
    status_info_in: 12,
    savekey: 'save-key',
    outputpath: 'output.docx'
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
});
