/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {afterEach, beforeEach, describe, expect, jest, test} = require('@jest/globals');
const canvasservice = require('../../DocService/sources/canvasservice');
const commonDefines = require('../../Common/sources/commondefines');
const constants = require('../../Common/sources/constants');
const docsCoServer = require('../../DocService/sources/DocsCoServer');
const {EditorData} = require('../../DocService/sources/editorDataMemory');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const storage = require('../../Common/sources/storage/storage-base');
const taskResult = require('../../DocService/sources/taskresult');

const ctx = {tenant: 'saved-state-tenant', getCfg: (_path, fallback) => fallback, logger: {debug() {}, error() {}, warn() {}}};
function command(overrides = {}) {
  return new commonDefines.InputCommand({
    id: 'document',
    userid: 'user',
    userindex: 1,
    status_info: constants.NO_ERROR,
    status_info_in: 12,
    savekey: 'save-key',
    outputpath: 'output.docx',
    ...overrides
  });
}

describe('final-save saved-state handling', () => {
  let caseId = 0;
  beforeEach(() => {
    ctx.tenant = `saved-state-tenant-${++caseId}`;
    jest.spyOn(taskResult, 'select').mockResolvedValue([
      {
        callback: 'https://callback.example.test/save',
        baseurl: 'https://storage.example.test',
        status: commonDefines.FileStatus.SaveVersion,
        status_info: 12
      }
    ]);
    jest.spyOn(taskResult, 'updateIf').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'removeIf').mockResolvedValue({affectedRows: 0});
    jest.spyOn(sqlBase.UserCallback.prototype, 'getCallbackByUserIndex').mockReturnValue('https://callback.example.test/save');
    jest.spyOn(storage, 'listObjects').mockResolvedValue([]);
    jest.spyOn(storage, 'getObject').mockResolvedValue(Buffer.from('{}'));
    jest.spyOn(storage, 'getSignedUrl').mockResolvedValue('https://storage.example.test/signed');
    jest.spyOn(storage, 'copyObject').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer, 'getEditorsCountPromise').mockResolvedValue(0);
    jest.spyOn(docsCoServer.editorData, 'getForceSave').mockResolvedValue(null);
    jest.spyOn(docsCoServer, 'sendServerRequest').mockResolvedValue('{"error":0}');
    jest.spyOn(docsCoServer, 'parseReplyData').mockReturnValue({error: 0});
    jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(true);
    jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('a normal save succeeds with the real memory backend and no saved status', async () => {
    const previous = docsCoServer.editorData;
    docsCoServer.editorData = new EditorData();
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    try {
      await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).resolves.toBe('{"error":0}');
      expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(ctx, 'document', true, 1, undefined);
      expect(docsCoServer.publish).toHaveBeenCalledWith(ctx, expect.objectContaining({success: true}));
      expect(storage.copyObject).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
    } finally {
      docsCoServer.editorData = previous;
    }
  });

  test.each(['1', '0'])('acknowledges status %s only after its successful or forgotten-file cleanup', async status => {
    await docsCoServer.editorData.setSaved(ctx, 'document', status);
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    await canvasservice.commandSfcCallback(ctx, command(), false, false);
    expect(read).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(ctx, 'document', status === '1', 1, 'save-key');
    expect(ack).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(docsCoServer.cleanDocumentOnExitPromise.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(docsCoServer.publish.mock.invocationCallOrder[0]);
    expect(docsCoServer.publish).toHaveBeenCalledWith(ctx, expect.objectContaining({success: status === '1'}));
    expect(storage.copyObject).toHaveBeenCalledTimes(status === '1' ? 0 : 1);
    expect(taskResult.removeIf).toHaveBeenCalledTimes(status === '1' ? 0 : 1);
  });

  test.each(['1', '0'])('does not acknowledge status %s when cleanup throws', async status => {
    const error = new Error('cleanup failed');
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue(status);
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    docsCoServer.cleanDocumentOnExitPromise.mockRejectedValue(error);
    await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).rejects.toBe(error);
    expect(ack).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
  });

  test.each([new Error('Redis unavailable'), Object.assign(new Error('unknown outcome'), {code: 'EDITOR_DATA_SAVED_UNKNOWN'})])(
    'propagates saved-state errors before destructive cleanup: %s',
    async error => {
      jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockRejectedValue(error);
      const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
      await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).rejects.toBe(error);
      expect(docsCoServer.cleanDocumentOnExitPromise).not.toHaveBeenCalled();
      expect(storage.copyObject).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(docsCoServer.publish).not.toHaveBeenCalled();
    }
  );

  test('does not publish success when acknowledgement fails', async () => {
    const error = new Error('acknowledgement unavailable');
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    jest.spyOn(docsCoServer.editorData, 'ackSaved').mockRejectedValue(error);
    await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).rejects.toBe(error);
    expect(docsCoServer.publish).not.toHaveBeenCalled();
  });

  test('keeps cache and changes when the backend declines forgotten-file cleanup', async () => {
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(false);
    await canvasservice.commandSfcCallback(ctx, command(), false, false);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(taskResult.removeIf).not.toHaveBeenCalled();
  });

  test('uses a stable fallback operation id for older tasks without a save key', async () => {
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    await canvasservice.commandSfcCallback(ctx, command({savekey: undefined}), false, false);
    await canvasservice.commandSfcCallback(ctx, command({savekey: undefined}), false, false);
    expect(read.mock.calls.map(call => call[2])).toEqual(['fallback:output.docx:12:user', 'fallback:output.docx:12:user']);
    expect(ack.mock.calls.map(call => call[2])).toEqual(read.mock.calls.map(call => call[2]));
  });

  test.each([
    ['conversion error', {statusInfo: constants.CONVERT_READ_FILE, encrypted: false}],
    ['encrypted save', {statusInfo: constants.NO_ERROR, encrypted: true}],
    ['missing output file', {statusInfo: constants.NO_ERROR, encrypted: false, missingFile: true}]
  ])('acknowledges a saved status on the %s path', async (_scenario, options) => {
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    if (options.missingFile) {
      storage.getSignedUrl.mockResolvedValue(undefined);
    }

    await canvasservice.commandSfcCallback(ctx, command({status_info: options.statusInfo}), false, options.encrypted);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
  });

  test('force-save callbacks do not consume or acknowledge final-save state', async () => {
    taskResult.select.mockResolvedValue([
      {callback: 'https://callback.example.test/save', baseurl: 'https://storage.example.test', status: commonDefines.FileStatus.Ok}
    ]);
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    await canvasservice.commandSfcCallback(ctx, command(), true, false);
    expect(read).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });
});

// Exercise the production wrapper as well as the callback's exported entry point.
describe('document cleanup completion contract', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([false, undefined, new Error('storage unavailable')])('stops destructive follow-up for %s', async result => {
    const clean = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');
    if (result instanceof Error) {
      clean.mockRejectedValue(result);
    } else {
      clean.mockResolvedValue(result);
    }
    const restore = jest.spyOn(taskResult, 'restoreInitialPassword');
    const removeChanges = jest.spyOn(sqlBase, 'deleteChanges');
    const removeFiles = jest.spyOn(storage, 'deletePath');
    const select = jest.spyOn(taskResult, 'select');
    const cleanup = docsCoServer.cleanDocumentOnExitPromise(ctx, 'document', true, 1, 'save-key');
    if (result instanceof Error) {
      await expect(cleanup).rejects.toBe(result);
    } else {
      await expect(cleanup).resolves.toBe(false);
    }
    expect(clean).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(restore).not.toHaveBeenCalled();
    expect(removeChanges).not.toHaveBeenCalled();
    expect(removeFiles).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  test('cleans changes and files only after backend cleanup completes', async () => {
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    const restore = jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    const removeChanges = jest.spyOn(sqlBase, 'deleteChanges').mockResolvedValue(undefined);
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    await expect(docsCoServer.cleanDocumentOnExitPromise(ctx, 'document', true, 1, 'save-key')).resolves.toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(removeChanges).toHaveBeenCalledWith(ctx, 'document', null);
    expect(removeFiles).toHaveBeenCalledTimes(1);
  });
});
