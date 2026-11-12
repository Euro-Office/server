/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {beforeEach, describe, expect, jest, test} = require('@jest/globals');
const {Readable} = require('node:stream');
const constants = require('../../Common/sources/constants');
const commonDefines = require('../../Common/sources/commondefines');
const config = require('../../DocService/node_modules/config');

const sqlBase = {
  UserCallback: class {
    getCallbackByUserIndex(_ctx, callback) {
      return callback;
    }
  },
  deleteChanges: jest.fn()
};
const taskResult = {
  TaskResultData: class {},
  select: jest.fn(),
  updateIf: jest.fn(),
  removeIf: jest.fn()
};
const storage = {
  listObjects: jest.fn(),
  getObject: jest.fn(),
  getSignedUrl: jest.fn(),
  headObject: jest.fn(),
  createReadStream: jest.fn(),
  copyObject: jest.fn(),
  deletePath: jest.fn()
};
const wopiClient = {
  parseWopiCallback: jest.fn(),
  putFile: jest.fn(),
  parsePutFileResponse: jest.fn(),
  putRelativeFile: jest.fn()
};
const docsCoServer = {
  c_oAscServerStatus: {MustSave: 2, Corrupted: 3, MustSaveForce: 6, CorruptedForce: 7},
  editorData: {getForceSave: jest.fn(), getdelSaved: jest.fn(), cleanDocumentOnExit: jest.fn()},
  getEditorsCountPromise: jest.fn(),
  getCallback: jest.fn(),
  sendServerRequest: jest.fn(),
  parseReplyData: jest.fn(),
  setForceSave: jest.fn(),
  cleanDocumentOnExitPromise: jest.fn(),
  unlockWopiDoc: jest.fn(),
  publish: jest.fn(),
  getIsShutdown: jest.fn(),
  getIsPreStop: jest.fn()
};

// Keep callback decisions real while replacing database, storage and host I/O.
jest.doMock('../../DocService/sources/databaseConnectors/baseConnector', () => sqlBase);
jest.doMock('../../DocService/sources/taskresult', () => taskResult);
jest.doMock('../../DocService/sources/DocsCoServer', () => docsCoServer);
jest.doMock('../../DocService/sources/wopiClient', () => wopiClient);
jest.doMock('../../Common/sources/storage/storage-base', () => storage);
jest.doMock('../../DocService/sources/utilsDocService', () => ({}));
const {commandSfcCallback} = require('../../DocService/sources/canvasservice');

const docId = 'document-id';
const outputPath = `${docId}-save/output.docx`;
const wopiParams = {userAuth: {wopiSrc: 'https://host.test/wopi/files/1', access_token: 'fixture-token'}};
let updatedTasks;

beforeEach(() => {
  jest.resetAllMocks();
  updatedTasks = [];
  taskResult.updateIf.mockImplementation(async (_ctx, task) => {
    updatedTasks.push({...task});
    return {affectedRows: 1};
  });
  taskResult.removeIf.mockResolvedValue({affectedRows: 1});
  storage.listObjects.mockResolvedValue([]);
  storage.getObject.mockResolvedValue(Buffer.from('{"changes":[]}'));
  storage.getSignedUrl.mockImplementation(async (_ctx, _base, path) => `https://download.test/${path}`);
  storage.headObject.mockResolvedValue({ContentLength: 7});
  storage.createReadStream.mockImplementation(async () => ({readStream: Readable.from('fixture'), contentLength: 7}));
  storage.copyObject.mockResolvedValue(undefined);
  storage.deletePath.mockResolvedValue(undefined);
  sqlBase.deleteChanges.mockResolvedValue(undefined);
  wopiClient.parseWopiCallback.mockReturnValue(wopiParams);
  wopiClient.putFile.mockResolvedValue({statusCode: 200, body: '{}'});
  wopiClient.parsePutFileResponse.mockReturnValue({});
  wopiClient.putRelativeFile.mockResolvedValue({statusCode: 200, body: '{}'});
  docsCoServer.getEditorsCountPromise.mockResolvedValue(0);
  docsCoServer.getCallback.mockResolvedValue({wopiParams});
  docsCoServer.editorData.getForceSave.mockResolvedValue(undefined);
  docsCoServer.editorData.getdelSaved.mockResolvedValue(undefined);
  docsCoServer.editorData.cleanDocumentOnExit.mockResolvedValue(undefined);
  docsCoServer.sendServerRequest.mockResolvedValue('{"error":0}');
  docsCoServer.parseReplyData.mockImplementation((_ctx, reply) => (reply ? JSON.parse(reply) : undefined));
  docsCoServer.setForceSave.mockImplementation(function* () {});
  docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(undefined);
  docsCoServer.unlockWopiDoc.mockResolvedValue(undefined);
  docsCoServer.publish.mockResolvedValue(undefined);
  docsCoServer.getIsShutdown.mockReturnValue(false);
  docsCoServer.getIsPreStop.mockReturnValue(false);
});

function createSave({force = false, status = constants.NO_ERROR, type = commonDefines.c_oAscForceSaveTypes.Timeout} = {}) {
  const ctx = {
    tenant: 'localhost',
    logger: {debug: jest.fn(), warn: jest.fn(), error: jest.fn()},
    getCfg: (_key, fallback) => fallback
  };
  const cmd = new commonDefines.InputCommand({id: docId, userid: 'editor-user', savekey: '-save', outputpath: 'output.docx'});
  cmd.setStatusInfo(status);
  cmd.setStatusInfoIn(17);
  cmd.setOutputFormat(constants.AVS_OFFICESTUDIO_FILE_DOCUMENT_DOCX);
  if (force) {
    cmd.setForceSave(new commonDefines.CForceSaveData({type, time: 1700000000000}));
  }
  taskResult.select.mockResolvedValue([
    {
      callback: 'https://host.test/callback',
      baseurl: 'https://editor.test',
      status: force ? commonDefines.FileStatus.Ok : commonDefines.FileStatus.SaveVersion,
      status_info: 17
    }
  ]);
  return {ctx, cmd};
}

describe('WOPI converter-error save callbacks', () => {
  test.each([
    ['automatic force-save', true, commonDefines.c_oAscForceSaveTypes.Timeout, true, true, false],
    ['button force-save', true, commonDefines.c_oAscForceSaveTypes.Button, true, false, false],
    ['final save', false, undefined, true, false, true]
  ])('keeps successful %s writes and WOPI save flags', async (_name, force, type, modified, autosave, exitSave) => {
    const {ctx, cmd} = createSave({force, type});
    const reply = await commandSfcCallback(ctx, cmd, force);

    expect(JSON.parse(reply)).toEqual({error: 0});
    expect(wopiClient.putFile).toHaveBeenCalledTimes(1);
    expect(wopiClient.putFile).toHaveBeenCalledWith(ctx, wopiParams, null, expect.any(Readable), 7, 'editor-user', modified, autosave, exitSave);
    expect(storage.copyObject).not.toHaveBeenCalled();
    if (force) {
      expect(docsCoServer.setForceSave).toHaveBeenCalledWith(ctx, docId, cmd.getForceSave(), cmd, true, expect.any(String));
    } else {
      expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(ctx, docId, true, undefined);
    }
  });

  test.each([true, false])('does not upload a corrupted output with a URL (force-save: %s)', async force => {
    const {ctx, cmd} = createSave({force, status: constants.CONVERT_CORRUPTED});
    const reply = await commandSfcCallback(ctx, cmd, force);

    expect(storage.getSignedUrl).toHaveBeenCalledWith(ctx, 'https://editor.test', outputPath, commonDefines.c_oAscUrlTypes.Temporary);
    expect(wopiClient.putFile).not.toHaveBeenCalled();
    expect(storage.createReadStream).not.toHaveBeenCalled();
    expect(JSON.parse(reply).error).not.toBe(0);
    if (force) {
      expect(docsCoServer.setForceSave).toHaveBeenCalledWith(ctx, docId, cmd.getForceSave(), cmd, false, expect.any(String));
    } else {
      expect(updatedTasks.map(task => task.status)).toEqual([commonDefines.FileStatus.UpdateVersion, commonDefines.FileStatus.SaveVersion]);
      expect(storage.copyObject).toHaveBeenCalledWith(
        ctx,
        outputPath,
        `${docId}/${config.get('services.CoAuthoring.server.forgottenfilesname')}.docx`,
        undefined,
        config.get('services.CoAuthoring.server.forgottenfiles')
      );
      expect(docsCoServer.cleanDocumentOnExitPromise).not.toHaveBeenCalled();
      expect(docsCoServer.editorData.cleanDocumentOnExit).toHaveBeenCalledWith(ctx, docId);
      expect(docsCoServer.unlockWopiDoc).toHaveBeenCalledWith(ctx, docId, undefined);
    }
  });

  test('keeps the not-modified flag on a successful final save', async () => {
    const {ctx, cmd} = createSave();
    docsCoServer.editorData.getForceSave.mockResolvedValue({ended: true});

    await commandSfcCallback(ctx, cmd, false);

    expect(wopiClient.putFile).toHaveBeenCalledWith(ctx, wopiParams, null, expect.any(Readable), 7, 'editor-user', false, false, true);
  });

  test.each([true, false])('preserves non-WOPI corrupted callbacks and their partial output URL (force-save: %s)', async force => {
    const {ctx, cmd} = createSave({force, status: constants.CONVERT_CORRUPTED});
    wopiClient.parseWopiCallback.mockReturnValue(undefined);

    await commandSfcCallback(ctx, cmd, force);

    expect(wopiClient.putFile).not.toHaveBeenCalled();
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    const output = docsCoServer.sendServerRequest.mock.calls[0][2];
    expect(output.getStatus()).toBe(force ? docsCoServer.c_oAscServerStatus.CorruptedForce : docsCoServer.c_oAscServerStatus.Corrupted);
    expect(output.getUrl()).toBe(`https://download.test/${outputPath}`);
    expect(output.getChangeHistory()).toEqual({changes: []});
  });

  test.each([constants.NO_ERROR, constants.CONVERT_CORRUPTED])('protects form save-as output with converter status %s', async status => {
    const {ctx, cmd} = createSave({force: true, type: commonDefines.c_oAscForceSaveTypes.Form, status});

    const reply = await commandSfcCallback(ctx, cmd, true);

    expect(wopiClient.putFile).not.toHaveBeenCalled();
    if (status === constants.NO_ERROR) {
      expect(wopiClient.putRelativeFile).toHaveBeenCalledTimes(1);
      expect(JSON.parse(reply).error).toBe(0);
    } else {
      expect(wopiClient.putRelativeFile).not.toHaveBeenCalled();
      expect(JSON.parse(reply).error).not.toBe(0);
    }
  });
});
