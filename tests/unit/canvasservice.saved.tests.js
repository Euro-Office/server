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
const wopiClient = require('../../DocService/sources/wopiClient');
const wopiUtils = require('../../DocService/sources/wopiUtils');
const utils = require('../../Common/sources/utils');
const config = require('../../Common/node_modules/config');
const operationContext = require('../../Common/sources/operationContext');
const TaskQueue = require('../../Common/sources/taskqueueRabbitMQ');
const sqlConnectorNames = {
  mysql: 'mysqlConnector',
  mariadb: 'mysqlConnector',
  mssql: 'mssqlConnector',
  oracle: 'oracleConnector'
};
const sqlConnectorName = sqlConnectorNames[config.get('services.CoAuthoring.sql.type')] || 'postgreConnector';
const sqlConnector = require(`../../DocService/sources/databaseConnectors/${sqlConnectorName}`);

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
  let selectedRow;
  beforeEach(() => {
    ctx.tenant = `saved-state-tenant-${++caseId}`;
    selectedRow = {
      callback: 'https://callback.example.test/save',
      baseurl: 'https://storage.example.test',
      status: commonDefines.FileStatus.SaveVersion,
      status_info: 12,
      additional: null
    };
    jest.spyOn(taskResult, 'select').mockResolvedValue([selectedRow]);
    jest.spyOn(taskResult, 'updateIf').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'claimIf').mockImplementation(async (_ctx, update) => {
      selectedRow.status = update.status;
      selectedRow.status_info = update.statusInfo;
      return {affectedRows: 1};
    });
    jest.spyOn(taskResult, 'removeIf').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'deleteChangesIf').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'withCleanupOwnership').mockImplementation(async (_ctx, mask, action) => {
      const rows = await taskResult.select(_ctx, mask.key);
      if (!canvasservice.taskResultMatchesMask(rows[0], mask)) {
        return false;
      }
      await action(rows[0]);
      return true;
    });
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
    jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* () {});
  });
  afterEach(() => jest.restoreAllMocks());

  // Conditional updates, claims and removals applied to selectedRow, as the SQL does.
  function useRowModel() {
    let removed = false;
    const matches = mask =>
      !removed &&
      (mask.status === undefined || mask.status === null || selectedRow.status === mask.status) &&
      (mask.statusInfo === undefined || mask.statusInfo === null || selectedRow.status_info === mask.statusInfo) &&
      (mask.additional === undefined || mask.additional === null || selectedRow.additional === mask.additional);
    const update = async (_ctx, task, mask) => {
      if (!matches(mask)) {
        return {affectedRows: 0};
      }
      if (task.status !== undefined && task.status !== null) {
        selectedRow.status = task.status;
      }
      if (task.statusInfo !== undefined && task.statusInfo !== null) {
        selectedRow.status_info = task.statusInfo;
      }
      if (task.additional !== undefined && task.additional !== null) {
        selectedRow.additional = task.replaceAdditional ? task.additional : (selectedRow.additional || '') + task.additional;
      }
      return {affectedRows: 1};
    };
    taskResult.select.mockImplementation(async () => (removed ? [] : [{...selectedRow}]));
    taskResult.updateIf.mockImplementation(update);
    taskResult.claimIf.mockImplementation(update);
    taskResult.removeIf.mockImplementation(async (_ctx, mask) => {
      if (!matches(mask)) {
        return {affectedRows: 0};
      }
      removed = true;
      return {affectedRows: 1};
    });
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
  }

  test('a normal save succeeds with the real memory backend and no saved status', async () => {
    const previous = docsCoServer.editorData;
    docsCoServer.editorData = new EditorData();
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    try {
      await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).resolves.toBe('{"error":0}');
      expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(
        ctx,
        'document',
        true,
        1,
        undefined,
        expect.objectContaining({status: commonDefines.FileStatus.UpdateVersion, statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO})
      );
      expect(docsCoServer.publish).toHaveBeenCalledWith(ctx, expect.objectContaining({success: true}));
      expect(storage.copyObject).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
    } finally {
      docsCoServer.editorData = previous;
    }
  });

  test.each(['1', '0'])('acknowledges status %s only after its successful or forgotten-file cleanup', async status => {
    useRowModel();
    await docsCoServer.editorData.setSaved(ctx, 'document', status);
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    await canvasservice.commandSfcCallback(ctx, command(), false, false);
    expect(read).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    if (status === '1') {
      expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(ctx, 'document', true, 1, 'save-key', expect.anything());
    } else {
      // Reported unsaved: the save continues as a declined one and keeps its claim.
      expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(
        ctx,
        'document',
        false,
        1,
        'save-key',
        expect.objectContaining({status: commonDefines.FileStatus.SaveVersion, statusInfo: 12})
      );
    }
    expect(ack).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(docsCoServer.cleanDocumentOnExitPromise.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(docsCoServer.publish.mock.invocationCallOrder[0]);
    expect(docsCoServer.publish).toHaveBeenCalledWith(ctx, expect.objectContaining({success: status === '1'}));
    expect(storage.copyObject).toHaveBeenCalledTimes(status === '1' ? 0 : 1);
    expect(taskResult.deleteChangesIf).toHaveBeenCalledTimes(status === '1' ? 0 : 1);
    // A declined save's row is removed.
    expect(taskResult.removeIf).toHaveBeenCalledTimes(status === '1' ? 0 : 1);
    if (status === '0') {
      expect(storage.copyObject.mock.invocationCallOrder[0]).toBeLessThan(docsCoServer.cleanDocumentOnExitPromise.mock.invocationCallOrder[0]);
      expect(taskResult.deleteChangesIf.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    }
  });

  test.each(['1', '0'])('does not acknowledge status %s when cleanup throws', async status => {
    useRowModel();
    const error = new Error('cleanup failed');
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue(status);
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    docsCoServer.cleanDocumentOnExitPromise.mockRejectedValue(error);
    await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).rejects.toBe(error);
    expect(ack).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
  });

  test.each([null, new Error('SQL deletion failed')])('waits for SQL deletion before acknowledging a claim: %s', async error => {
    useRowModel();
    docsCoServer.cleanDocumentOnExitPromise.mockRestore();
    taskResult.deleteChangesIf.mockRestore();
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    taskResult.removeIf.mockResolvedValue({affectedRows: 1});
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    let completeDeletion;
    const started = new Promise(resolve => {
      if (sqlConnector.deleteChangesIf) {
        jest.spyOn(sqlConnector, 'deleteChangesIf').mockImplementation(
          () =>
            new Promise((complete, reject) => {
              completeDeletion = (error, result) => (error ? reject(error) : complete(result));
              resolve();
            })
        );
      } else {
        jest.spyOn(sqlConnector, 'sqlQuery').mockImplementation((_ctx, _sql, callback) => {
          completeDeletion = callback;
          resolve();
        });
      }
    });

    const save = canvasservice.commandSfcCallback(ctx, command(), false, false);
    const outcome = error ? expect(save).rejects.toBe(error) : expect(save).resolves.toBe('{"error":0}');
    await started;
    await new Promise(setImmediate);
    expect(ack).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();

    completeDeletion(error, {affectedRows: 1});
    await outcome;
    if (error) {
      expect(ack).not.toHaveBeenCalled();
      expect(docsCoServer.publish).not.toHaveBeenCalled();
    } else {
      expect(ack).toHaveBeenCalledWith(ctx, 'document', 'save-key');
      expect(docsCoServer.publish).toHaveBeenCalledWith(ctx, expect.objectContaining({success: true}));
    }
  });

  test('keeps the task row until SQL deletion succeeds so cleanup can be retried', async () => {
    taskResult.removeIf.mockRestore();
    taskResult.deleteChangesIf.mockRestore();
    const error = new Error('SQL deletion failed');
    const removeChanges = jest.spyOn(sqlBase, 'deleteChangesPromise').mockRejectedValueOnce(error).mockResolvedValueOnce({affectedRows: 1});
    const removeRow = jest.spyOn(sqlBase, 'sqlQuery').mockImplementation((_ctx, _sql, callback) => callback(null, {affectedRows: 1}));
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const mask = {tenant: ctx.tenant, key: 'document', status: commonDefines.FileStatus.SaveVersion, statusInfo: 12};
    taskResult.claimIf.mockImplementation(async (_ctx, update) => {
      taskResult.select.mockResolvedValue([{status: update.status, status_info: update.statusInfo, last_open_date: null}]);
      return {affectedRows: 1};
    });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).rejects.toBe(error);
    expect(removeRow).not.toHaveBeenCalled();
    expect(storage.deletePath).not.toHaveBeenCalled();

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(true);
    expect(removeChanges).toHaveBeenCalledTimes(2);
    expect(removeRow).toHaveBeenCalledTimes(1);
    expect(storage.deletePath).toHaveBeenCalledTimes(1);
  });

  test('keeps the task row when cache storage deletion fails so cleanup can be retried', async () => {
    const error = new Error('cache storage unavailable');
    const mask = {tenant: ctx.tenant, key: 'document', status: commonDefines.FileStatus.SaveVersion, statusInfo: 12};
    let rowPresent = true;
    taskResult.select.mockImplementation(async () =>
      rowPresent
        ? [
            {
              status: commonDefines.FileStatus.SaveVersion,
              status_info: 12,
              last_open_date: null
            }
          ]
        : []
    );
    taskResult.claimIf.mockImplementation(async (_ctx, update) => {
      taskResult.select.mockImplementation(async () =>
        rowPresent ? [{status: update.status, status_info: update.statusInfo, last_open_date: null}] : []
      );
      return {affectedRows: 1};
    });
    const removeRow = jest.spyOn(taskResult, 'removeIf').mockImplementation(async () => {
      rowPresent = false;
      return {affectedRows: 1};
    });
    const removeFiles = jest.spyOn(storage, 'deletePath').mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).rejects.toBe(error);
    expect(taskResult.deleteChangesIf).toHaveBeenCalledTimes(1);
    expect(removeRow).not.toHaveBeenCalled();

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(true);
    expect(removeFiles).toHaveBeenCalledTimes(2);
    expect(taskResult.deleteChangesIf).toHaveBeenCalledTimes(2);
    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test('does not delete cache when ownership changes before conditional removal', async () => {
    const mask = {tenant: ctx.tenant, key: 'document', status: commonDefines.FileStatus.UpdateVersion, statusInfo: 12};
    let ownershipChanged = false;
    taskResult.select.mockImplementation(async () => {
      return [
        {
          status: ownershipChanged ? commonDefines.FileStatus.SaveVersion : commonDefines.FileStatus.UpdateVersion,
          status_info: ownershipChanged ? 13 : 12,
          last_open_date: null
        }
      ];
    });
    const claimIf = taskResult.claimIf.mockImplementation(async () => {
      ownershipChanged = true;
      return {affectedRows: 0};
    });
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    expect(claimIf).toHaveBeenCalledWith(ctx, expect.anything(), mask);
    expect(removeFiles).not.toHaveBeenCalled();
    expect(ownershipChanged).toBe(true);
  });

  test('claims cache ownership before storage deletion so a newer save cannot replace it', async () => {
    const mask = {tenant: ctx.tenant, key: 'document', status: commonDefines.FileStatus.SaveVersion, statusInfo: 12};
    const row = {status: commonDefines.FileStatus.SaveVersion, status_info: 12, last_open_date: null};
    taskResult.select.mockResolvedValue([row]);
    const claimIf = taskResult.claimIf.mockImplementation(async (_ctx, update, claimMask) => {
      expect(claimMask).toBe(mask);
      row.status = update.status;
      row.status_info = update.statusInfo;
      return {affectedRows: 1};
    });
    const saveAttempt = jest.spyOn(taskResult, 'updateIf').mockImplementation(async (_ctx, _update, saveMask) => {
      if (row.status !== saveMask.status || row.status_info !== saveMask.statusInfo) {
        return {affectedRows: 0};
      }
      row.status = commonDefines.FileStatus.SaveVersion;
      row.status_info = 13;
      return {affectedRows: 1};
    });
    const removeIf = jest.spyOn(taskResult, 'removeIf').mockResolvedValue({affectedRows: 1});
    jest.spyOn(storage, 'deletePath').mockImplementation(async () => {
      const newerSave = await taskResult.updateIf(ctx, {status: commonDefines.FileStatus.SaveVersion}, mask);
      expect(newerSave.affectedRows).toBe(0);
    });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(true);

    expect(claimIf).toHaveBeenCalledTimes(1);
    expect(saveAttempt).toHaveBeenCalledTimes(1);
    expect(taskResult.deleteChangesIf).toHaveBeenCalledWith(ctx, expect.objectContaining({status: commonDefines.FileStatus.UpdateVersion}));
    expect(removeIf).toHaveBeenCalledWith(ctx, expect.objectContaining({status: commonDefines.FileStatus.UpdateVersion}));
    expect(storage.deletePath).toHaveBeenCalledTimes(1);
  });

  test('reports incomplete cache cleanup when the final conditional removal loses ownership', async () => {
    const mask = {tenant: ctx.tenant, key: 'document', status: commonDefines.FileStatus.UpdateVersion, statusInfo: 12};
    taskResult.select.mockResolvedValue([{status: commonDefines.FileStatus.UpdateVersion, status_info: 12, last_open_date: null}]);
    const removeIf = jest.spyOn(taskResult, 'removeIf').mockResolvedValueOnce({affectedRows: 0});
    taskResult.claimIf.mockImplementation(async (_ctx, update) => {
      taskResult.select.mockResolvedValue([{status: update.status, status_info: update.statusInfo, last_open_date: null}]);
      return {affectedRows: 1};
    });
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    expect(taskResult.deleteChangesIf).toHaveBeenCalledWith(ctx, expect.objectContaining({status: commonDefines.FileStatus.UpdateVersion}));
    expect(removeIf).toHaveBeenCalledTimes(1);
    expect(removeIf).toHaveBeenCalledWith(ctx, expect.objectContaining({status: commonDefines.FileStatus.UpdateVersion}));
    expect(removeFiles).toHaveBeenCalledTimes(1);
  });

  test('treats an already removed cache row as completed cleanup', async () => {
    taskResult.select.mockResolvedValue([]);
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);

    // GC's cleanupCache reports that it removed nothing.
    jest.spyOn(taskResult, 'remove').mockResolvedValue({affectedRows: 0});
    await expect(canvasservice.cleanupCache(ctx, 'document')).resolves.toBe(false);
    await expect(
      canvasservice.cleanupCacheIf(ctx, {
        tenant: ctx.tenant,
        key: 'document',
        status: commonDefines.FileStatus.UpdateVersion,
        statusInfo: 12
      })
    ).resolves.toBe(true);

    expect(removeFiles).not.toHaveBeenCalled();
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

  test.each([
    ['1', false],
    ['1', undefined],
    ['0', false],
    ['0', undefined]
  ])('retains status %s when cleanup returns %s', async (status, cleanupResult) => {
    useRowModel();
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue(status);
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(cleanupResult);
    await canvasservice.commandSfcCallback(ctx, command(), false, false);
    expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(status === '0' ? 1 : 0);
    expect(taskResult.removeIf).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).not.toHaveBeenCalled();
  });

  test('retains the claim and source files when forgotten-file preservation fails', async () => {
    useRowModel();
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    const error = new Error('recovery storage unavailable');
    storage.copyObject.mockRejectedValue(error);

    await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).rejects.toBe(error);

    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(docsCoServer.cleanDocumentOnExitPromise).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  test('does not acknowledge before forgotten-file cache cleanup completes', async () => {
    const error = new Error('cache cleanup failed');
    useRowModel();
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    taskResult.deleteChangesIf.mockRejectedValue(error);

    await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).rejects.toBe(error);

    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
  });

  test.each([false, undefined, true])('reopened forgotten-document cache deletion requires completed cleanup (%s)', async cleanupResult => {
    useRowModel();
    storage.listObjects.mockResolvedValueOnce(['document/forgotten.docx']).mockResolvedValueOnce(['document/forgotten.txt']);
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(cleanupResult);
    const removeFiles = storage.deletePath;

    await expect(canvasservice.commandSfcCallback(ctx, command(), false, false)).resolves.toBe('{"error":0}');

    expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledWith(ctx, 'document', true, 1, 'save-key', expect.anything());
    if (cleanupResult === true) {
      // At completion, after the claim is acknowledged: cache, then the row.
      expect(ack).toHaveBeenCalledWith(ctx, 'document', 'save-key');
      expect(removeFiles).toHaveBeenCalledWith(ctx, 'document');
      expect(ack.mock.invocationCallOrder[0]).toBeLessThan(removeFiles.mock.invocationCallOrder[0]);
      expect(taskResult.removeIf).toHaveBeenCalledTimes(1);
    } else {
      expect(taskResult.removeIf).not.toHaveBeenCalled();
      expect(removeFiles).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
    }
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
  ])('retains an unhandled saved status on the %s path', async (_scenario, options) => {
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    if (options.missingFile) {
      storage.getSignedUrl.mockResolvedValue(undefined);
    }

    await canvasservice.commandSfcCallback(ctx, command({status_info: options.statusInfo}), false, options.encrypted);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ctx, 'document', 'save-key');
    expect(docsCoServer.cleanDocumentOnExitPromise).not.toHaveBeenCalled();
    expect(storage.copyObject).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  test('retains saved state while scheduling a retryable callback failure', async () => {
    docsCoServer.sendServerRequest.mockRejectedValue(Object.assign(new Error('callback unavailable'), {statusCode: 503}));
    docsCoServer.parseReplyData.mockReturnValue(null);
    jest.spyOn(docsCoServer, 'getIsShutdown').mockReturnValue(false);
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    const delayed = jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* () {});
    const cmd = command();

    await canvasservice.commandSfcCallback(ctx, cmd, false, false);

    expect(cmd.getAttempt()).toBe(1);
    expect(delayed).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(docsCoServer.cleanDocumentOnExitPromise).not.toHaveBeenCalled();
    expect(storage.copyObject).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
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

  test('does not enqueue an encrypted HTTP save as an unencrypted callback retry', async () => {
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    const ack = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(false);
    await canvasservice.commandSfcCallback(ctx, command(), false, true);
    expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });
});

describe('final-save queue recovery', () => {
  let row;
  beforeEach(() => {
    docsCoServer.editorData.savedClaims = {};
    docsCoServer.editorData.savedCallbackAccepted = {};
    row = {
      callback: 'https://callback.example.test/save',
      baseurl: 'https://storage.example.test',
      status: commonDefines.FileStatus.SaveVersion,
      status_info: 12,
      additional: null,
      removed: false
    };
    jest.spyOn(operationContext.Context.prototype, 'initTenantCache').mockResolvedValue(undefined);
    jest.spyOn(operationContext.Context.prototype, 'getCfg').mockImplementation((_path, fallback) => fallback);
    for (const level of ['debug', 'info', 'warn', 'error']) {
      jest.spyOn(operationContext.global.logger, level).mockImplementation(() => {});
    }
    jest.spyOn(taskResult, 'select').mockImplementation(async () => (row.removed ? [] : [row]));
    jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'updateIf').mockImplementation(async (_ctx, update, mask) => {
      if (row.removed || !canvasservice.taskResultMatchesMask(row, mask)) {
        return {affectedRows: 0};
      }
      // Like the SQL, leave fields the update does not set unchanged.
      if (update.status !== undefined && update.status !== null) {
        row.status = update.status;
      }
      if (update.statusInfo !== undefined && update.statusInfo !== null) {
        row.status_info = update.statusInfo;
      }
      if (update.additional !== undefined && update.additional !== null) {
        // Like the SQL: additional = COALESCE(additional, '') || $n
        row.additional = (row.additional || '') + update.additional;
      }
      return {affectedRows: 1};
    });
    jest.spyOn(taskResult, 'claimIf').mockImplementation(async (_ctx, update) => {
      if (row.removed) {
        return {affectedRows: 0};
      }
      row.status = update.status;
      row.status_info = update.statusInfo;
      return {affectedRows: 1};
    });
    jest.spyOn(taskResult, 'removeIf').mockResolvedValue({affectedRows: 0});
    jest.spyOn(taskResult, 'deleteChangesIf').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'withCleanupOwnership').mockImplementation(async (_ctx, mask, action) => {
      if (row.removed || !canvasservice.taskResultMatchesMask(row, mask)) {
        return false;
      }
      await action({...row});
      return true;
    });
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockResolvedValue({affectedRows: 1});
    // The session's changes are still in the database.
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockResolvedValue([{change_id: 3}]);
    jest.spyOn(sqlBase.UserCallback.prototype, 'getCallbackByUserIndex').mockReturnValue(row.callback);
    jest.spyOn(storage, 'listObjects').mockResolvedValue([]);
    jest.spyOn(storage, 'getObject').mockResolvedValue(Buffer.from('{}'));
    jest.spyOn(storage, 'getSignedUrl').mockResolvedValue('https://storage.example.test/signed');
    jest.spyOn(storage, 'copyObject').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer, 'getEditorsCountPromise').mockResolvedValue(0);
    jest.spyOn(docsCoServer.editorData, 'getForceSave').mockResolvedValue(null);
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1');
    jest.spyOn(docsCoServer.editorData, 'ackSaved').mockResolvedValue(true);
    jest.spyOn(docsCoServer, 'sendServerRequest').mockResolvedValue('{"error":0}');
    jest.spyOn(docsCoServer, 'parseReplyData').mockReturnValue({error: 0});
    jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockResolvedValue(true);
    jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* () {});
    jest.spyOn(docsCoServer, 'getIsShutdown').mockReturnValue(false);
  });
  afterEach(() => jest.restoreAllMocks());

  // Millisecond backoff delays, so that tests can wait out in-process retries.
  function useFastBackoff() {
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    const fast = {...options, timeout: {...options.timeout, minTimeout: 1}};
    operationContext.Context.prototype.getCfg.mockImplementation((path, fallback) =>
      path === 'services.CoAuthoring.callbackBackoffOptions' ? fast : fallback
    );
  }
  function queuedCommand(overrides = {}) {
    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant: 'queue-recovery', docId: 'document', userId: 'user'});
    task.setCmd(command({c: 'sfc', ...overrides}));
    return JSON.stringify(task);
  }

  test.each(['getForceSave', 'getdelSaved', 'cleanup', 'ackSaved', 'unknown claim'])(
    'confirms a retry before acknowledging a failed %s, then completes the same operation',
    async method => {
      const error = Object.assign(new Error('storage unavailable'), {code: 'EDITOR_DATA_SAVED_UNKNOWN'});
      const target =
        method === 'cleanup' ? docsCoServer.cleanDocumentOnExitPromise : docsCoServer.editorData[method === 'unknown claim' ? 'getdelSaved' : method];
      target.mockRejectedValueOnce(error);
      let confirm;
      let retryStarted;
      let retryTask;
      const confirmed = new Promise(resolve => (confirm = resolve));
      const started = new Promise(resolve => (retryStarted = resolve));
      docsCoServer.addDelayed.mockImplementationOnce(function* (task) {
        retryTask = new commonDefines.TaskQueueData(JSON.parse(JSON.stringify(task)));
        retryStarted();
        yield confirmed;
      });
      const ack = jest.fn();
      const processing = canvasservice.receiveTask(queuedCommand(), ack);
      await Promise.race([started, processing]);
      expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
      expect(docsCoServer.addDelayed.mock.calls[0].slice(2)).toEqual([undefined, true]);
      expect(ack).not.toHaveBeenCalled();
      expect(docsCoServer.publish).not.toHaveBeenCalled();
      expect(row.status).toBe(commonDefines.FileStatus.UpdateVersion);
      expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(method === 'getForceSave' ? 0 : 1);
      expect(retryTask.getCmd().getSaveKey()).toBe('save-key');
      expect(retryTask.getCmd().getOutputPath()).toBe('output.docx');
      expect(retryTask.getCmd().getStatusInfoIn()).toBe(12);
      expect(retryTask.getCmd().getAttempt()).toBe(1);
      confirm();
      await processing;
      expect(ack).toHaveBeenCalledTimes(1);

      const retryAck = jest.fn();
      await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);
      expect(retryAck).toHaveBeenCalledTimes(1);
      expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
      expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
      expect(docsCoServer.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({success: true}));
      expect(docsCoServer.editorData.ackSaved).toHaveBeenLastCalledWith(expect.anything(), 'document', 'save-key');
    }
  );

  test('keeps the broker delivery until a retry whose publication failed is confirmed', async () => {
    useFastBackoff();
    docsCoServer.editorData.getdelSaved.mockRejectedValueOnce(new Error('storage unavailable'));
    const ack = jest.fn();
    let confirmed;
    docsCoServer.addDelayed
      .mockImplementationOnce(function* () {
        yield Promise.reject(new Error('broker unavailable'));
      })
      .mockImplementationOnce(function* () {
        yield Promise.reject(new Error('broker unavailable'));
      })
      .mockImplementationOnce(function* (task) {
        expect(ack).not.toHaveBeenCalled();
        confirmed = new commonDefines.TaskQueueData(JSON.parse(JSON.stringify(task)));
        yield Promise.resolve();
      });
    await canvasservice.receiveTask(queuedCommand(), ack);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(3);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    // The confirmed retry keeps this attempt's state and counts the failed publications.
    expect(confirmed.getCmd().getAttempt()).toBe(3);
    expect(confirmed.getCmd().getCallbackAccepted()).toBe(true);
  });

  test('does not resend an accepted callback on broker redelivery after a worker restart', async () => {
    docsCoServer.cleanDocumentOnExitPromise.mockRejectedValueOnce(new Error('cleanup unavailable')).mockResolvedValueOnce(true);
    // The worker dies before the retry is confirmed, so the broker redelivers.
    docsCoServer.addDelayed.mockImplementationOnce(function* () {
      yield new Promise(() => {});
    });
    const original = queuedCommand();
    const firstAck = jest.fn();
    void canvasservice.receiveTask(original, firstAck);
    await new Promise(setImmediate);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_STATUS_INFO);
    expect(firstAck).not.toHaveBeenCalled();

    // The original broker payload has no acceptance marker. Simulate a
    // worker restart so only the task-row marker can suppress the callback.
    docsCoServer.editorData.savedCallbackAccepted = {};
    const redeliveryAck = jest.fn();
    await canvasservice.receiveTask(original, redeliveryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.cleanDocumentOnExitPromise).toHaveBeenCalledTimes(2);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(redeliveryAck).toHaveBeenCalledTimes(1);
  });

  test('does not resend after callback acceptance when SQL marker persistence fails', async () => {
    taskResult.updateIf
      .mockImplementationOnce(async (_ctx, update) => {
        row.status = update.status;
        row.status_info = update.statusInfo;
        return {affectedRows: 1};
      })
      .mockRejectedValueOnce(new Error('acceptance marker SQL unavailable'));
    const original = queuedCommand();
    const firstAck = jest.fn();

    await canvasservice.receiveTask(original, firstAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(firstAck).toHaveBeenCalledTimes(1);

    const redeliveryAck = jest.fn();
    await canvasservice.receiveTask(original, redeliveryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    // Completed: the pending status is released and the accepted marker stays.
    expect(row.status_info).toBeLessThan(commonDefines.FINAL_SAVE_PENDING_STATUS_INFO);
    expect(row.additional).toContain('"phase":"accepted"');
    expect(redeliveryAck).toHaveBeenCalledTimes(1);
  });

  test('does not resend an accepted callback when the original delivery arrives after retry completion', async () => {
    docsCoServer.cleanDocumentOnExitPromise.mockRejectedValueOnce(new Error('cleanup unavailable')).mockResolvedValueOnce(true);
    const original = queuedCommand();
    const firstAck = jest.fn();
    await canvasservice.receiveTask(original, firstAck);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(retryAck).toHaveBeenCalledTimes(1);

    const redeliveryAck = jest.fn();
    await canvasservice.receiveTask(original, redeliveryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(redeliveryAck).toHaveBeenCalledTimes(1);
  });

  test('retries the forgotten-file cache deletion at completion without resending the callback', async () => {
    storage.listObjects.mockResolvedValueOnce(['document/forgotten.docx']).mockResolvedValueOnce(['document/forgotten.txt']);
    const removeFiles = jest
      .spyOn(storage, 'deletePath')
      .mockRejectedValueOnce(new Error('cache storage unavailable'))
      .mockResolvedValueOnce(undefined);
    const firstAck = jest.fn();

    await canvasservice.receiveTask(queuedCommand(), firstAck);

    // The cache and row of a session opened from the forgotten file
    // go, at completion: storage first, while the row keeps opens out.
    expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO);
    expect(removeFiles).toHaveBeenCalledTimes(1);
    expect(removeFiles).toHaveBeenCalledWith(expect.anything(), 'document');
    expect(taskResult.removeIf).not.toHaveBeenCalled();
    expect(firstAck).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(removeFiles).toHaveBeenCalledTimes(2);
    expect(taskResult.removeIf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({statusInfo: commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO})
    );
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(retryAck).toHaveBeenCalledTimes(1);
  });

  test('an accepted save reported unsaved stores the forgotten file as a declined save, across a publication retry', async () => {
    docsCoServer.editorData.getdelSaved.mockResolvedValue('0');
    const removeIf = jest.spyOn(taskResult, 'removeIf').mockImplementation(async () => {
      row.removed = true;
      return {affectedRows: 1};
    });
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable')).mockResolvedValue(undefined);

    const firstAck = jest.fn();
    const original = queuedCommand();
    await canvasservice.receiveTask(original, firstAck);

    // The integrator's file lacks the changes: forgotten file first, then the
    // declined cleanup removes the row.
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(storage.copyObject.mock.invocationCallOrder[0]).toBeLessThan(taskResult.deleteChangesIf.mock.invocationCallOrder[0]);
    expect(removeIf).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(firstAck).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expect(docsCoServer.publish).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({success: false}));
    expect(retryAck).toHaveBeenCalledTimes(1);

    const redeliveryAck = jest.fn();
    await canvasservice.receiveTask(original, redeliveryAck);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(redeliveryAck).toHaveBeenCalledTimes(1);
  });

  test('retries password restoration after an accepted callback without resending it', async () => {
    docsCoServer.cleanDocumentOnExitPromise.mockRestore();
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    const restorePassword = jest
      .spyOn(taskResult, 'restoreInitialPassword')
      .mockRejectedValueOnce(new Error('password restoration unavailable'))
      .mockResolvedValue(undefined);
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const firstAck = jest.fn();

    await canvasservice.receiveTask(queuedCommand(), firstAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(restorePassword).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.ackSaved).not.toHaveBeenCalled();
    expect(firstAck).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(restorePassword).toHaveBeenCalledTimes(2);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(retryAck).toHaveBeenCalledTimes(1);
  });

  test('retries forgotten-file deletion after an accepted callback without resending it', async () => {
    docsCoServer.cleanDocumentOnExitPromise.mockRestore();
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockResolvedValue({affectedRows: 1});
    const deleteFiles = jest
      .spyOn(storage, 'deletePath')
      .mockRejectedValueOnce(new Error('forgotten-file deletion unavailable'))
      .mockResolvedValue(undefined);
    const firstAck = jest.fn();

    await canvasservice.receiveTask(queuedCommand(), firstAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(deleteFiles).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.ackSaved).not.toHaveBeenCalled();
    expect(firstAck).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(deleteFiles).toHaveBeenCalledTimes(2);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(retryAck).toHaveBeenCalledTimes(1);
  });

  test('a failed WOPI unlock after an accepted callback does not hold back completion', async () => {
    docsCoServer.cleanDocumentOnExitPromise.mockRestore();
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockResolvedValue({affectedRows: 1});
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    jest.spyOn(storage, 'headObject').mockResolvedValue({ContentLength: 1});
    jest.spyOn(storage, 'createReadStream').mockResolvedValue({readStream: {}});
    const wopiParams = {
      userAuth: {wopiSrc: 'https://wopi.example.test/file', access_token: 'token', mode: 'edit'},
      commonInfo: {lockId: 'lock', fileInfo: {SupportsLocks: true}}
    };
    jest.spyOn(wopiClient, 'parseWopiCallback').mockReturnValue(wopiParams);
    jest.spyOn(wopiClient, 'putFile').mockResolvedValue({body: ''});
    jest.spyOn(utils, 'checkHostFilter').mockImplementation(function* () {
      yield Promise.resolve();
      return 0;
    });
    jest.spyOn(wopiUtils, 'fillStandardHeaders').mockResolvedValue(undefined);
    jest
      .spyOn(utils, 'postRequestPromise')
      .mockRejectedValueOnce(new Error('WOPI unlock unavailable'))
      .mockResolvedValue({response: {headers: {}}});
    const unlock = jest.spyOn(wopiClient, 'unlock');
    jest.spyOn(canvasservice, 'commandOpenStartPromise').mockResolvedValue(undefined);
    const firstAck = jest.fn();

    await canvasservice.receiveTask(queuedCommand(), firstAck);

    // Unlock is best effort: its failure is logged by wopiClient and the save
    // completes without a retry (a retry would only get 409 or 401 again).
    expect(wopiClient.putFile).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(await unlock.mock.results[0].value).toBe(false);
    expect(utils.postRequestPromise).toHaveBeenCalledTimes(1);
    expect(canvasservice.commandOpenStartPromise).not.toHaveBeenCalled();
    expect(docsCoServer.addDelayed).not.toHaveBeenCalled();
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(docsCoServer.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({success: true}));
    expect(row.status_info).toBeLessThan(commonDefines.FINAL_SAVE_PENDING_STATUS_INFO);
    expect(firstAck).toHaveBeenCalledTimes(1);
  });

  test('retries update-version publication after an accepted callback without resending it', async () => {
    docsCoServer.publish.mockRejectedValueOnce(new Error('update-version publication unavailable')).mockResolvedValue(undefined);
    const firstAck = jest.fn();

    await canvasservice.receiveTask(queuedCommand(), firstAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(firstAck).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expect(retryAck).toHaveBeenCalledTimes(1);
  });

  test('resends the callback when the first response was not accepted', async () => {
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));
    docsCoServer.parseReplyData.mockImplementation((_ctx, reply) => (reply ? JSON.parse(reply) : null));

    await canvasservice.receiveTask(queuedCommand(), jest.fn());
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
    expect(docsCoServer.editorData.ackSaved).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(retryAck).toHaveBeenCalledTimes(1);
  });

  test('recovers an actual SQL cleanup failure with the memory saved-state backend', async () => {
    docsCoServer.cleanDocumentOnExitPromise.mockRestore();
    docsCoServer.editorData.getdelSaved.mockRestore();
    docsCoServer.editorData.ackSaved.mockRestore();
    await docsCoServer.editorData.setSaved({tenant: 'queue-recovery'}, 'document', '1');
    const read = jest.spyOn(docsCoServer.editorData, 'getdelSaved');
    const savedAck = jest.spyOn(docsCoServer.editorData, 'ackSaved');
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    taskResult.deleteChangesIf.mockRejectedValueOnce(new Error('SQL unavailable'));
    const ack = jest.fn();
    await canvasservice.receiveTask(queuedCommand(), ack);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(storage.deletePath).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(savedAck).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);

    const retryTask = docsCoServer.addDelayed.mock.calls[0][0];
    const retryAck = jest.fn();
    await canvasservice.receiveTask(JSON.stringify(retryTask), retryAck);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(taskResult.deleteChangesIf).toHaveBeenCalledTimes(2);
    expect(storage.deletePath).toHaveBeenCalledTimes(1);
    expect(savedAck).toHaveBeenCalledWith(expect.anything(), 'document', 'save-key');
    expect(docsCoServer.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({success: true}));
    expect(retryAck).toHaveBeenCalledTimes(1);
  });

  test('never buffers a retry in process memory, and gives up within the retry budget', async () => {
    useFastBackoff();
    const queue = new TaskQueue();
    docsCoServer.editorData.getdelSaved.mockRejectedValue(new Error('storage unavailable'));
    docsCoServer.addDelayed.mockRestore();
    const addDelayed = docsCoServer.addDelayed;
    jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* (task, ttl, _queue, requireConfirm) {
      yield* addDelayed(task, ttl, queue, requireConfirm);
    });
    const ack = jest.fn();
    await canvasservice.receiveTask(queuedCommand(), ack);
    const budget = config.get('services.CoAuthoring.callbackBackoffOptions').infraRetries;
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(budget);
    expect(queue.addDelayedStore).toEqual([]);
    expect(ack).toHaveBeenCalledTimes(1);
    // Given up after acceptance with the changes still there and the saved state
    // never read: the session is left to resume, and editors are told.
    expect(row.status).toBe(commonDefines.FileStatus.SaveVersion);
    expect(row.status_info).toBe(12);
    expect(docsCoServer.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion, success: false})
    );
  });

  test.each(['declined cleanup', 'forgotten copy'])('reschedules %s without completing the claim', async scenario => {
    if (scenario === 'declined cleanup') {
      docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(false);
    } else {
      docsCoServer.editorData.getdelSaved.mockResolvedValue('0');
      storage.copyObject.mockRejectedValue(new Error('forgotten storage unavailable'));
    }
    const ack = jest.fn();
    await canvasservice.receiveTask(queuedCommand(), ack);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.ackSaved).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
  });

  test('caps infrastructure backoff beyond the HTTP retry limit', async () => {
    docsCoServer.editorData.getdelSaved.mockRejectedValue(new Error('storage unavailable'));
    const ack = jest.fn();
    await canvasservice.receiveTask(queuedCommand({attempt: 10}), ack);
    const [task, timeout] = docsCoServer.addDelayed.mock.calls[0];
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    expect(task.getCmd().getAttempt()).toBe(11);
    const retry = require('../../DocService/node_modules/retry');
    expect(timeout).toBe(retry.createTimeout(options.retries, options.timeout));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('keeps shutdown bookkeeping pending while cleanup is deferred', async () => {
    docsCoServer.getIsShutdown.mockReturnValue(true);
    docsCoServer.cleanDocumentOnExitPromise.mockResolvedValue(false);
    const removeShutdown = jest.spyOn(docsCoServer.editorStat, 'removeShutdown').mockResolvedValue(undefined);
    await canvasservice.receiveTask(queuedCommand(), jest.fn());
    expect(removeShutdown).not.toHaveBeenCalled();
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
  });

  test('reschedules declined no-changes cleanup', async () => {
    const cleanup = jest.spyOn(docsCoServer, 'cleanDocumentOnExitNoChangesPromise').mockResolvedValue(false);
    const ack = jest.fn();
    await canvasservice.receiveTask(queuedCommand({status_info: constants.EDITOR_CHANGES}), ack);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('does not retry failures from other converter commands', async () => {
    taskResult.update.mockRejectedValue(new Error('SQL unavailable'));
    const ack = jest.fn();
    await canvasservice.receiveTask(queuedCommand({c: 'sfcm'}), ack);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).not.toHaveBeenCalled();
  });
});

describe('confirmed delayed-task persistence', () => {
  test('rejects confirmed-only retries while disconnected instead of buffering them', async () => {
    const queue = new TaskQueue();
    await expect(queue.addDelayed({id: 'save'}, 1000, true)).rejects.toThrow('retry was not persisted');
    expect(queue.addDelayedStore).toEqual([]);
  });

  test('rejects a confirmed-only response while disconnected instead of dropping it', async () => {
    // handleDeadLetter returns a delayed retry this way before it acknowledges the dead letter.
    const queue = new TaskQueue();
    await expect(queue.addResponse({id: 'save'}, true)).rejects.toThrow('response was not persisted');
    await expect(queue.addResponse({id: 'save'})).resolves.toBeUndefined();
  });

  test.each([null, new Error('broker rejected retry')])('waits for broker confirmation and propagates its result (%s)', async error => {
    const queue = new TaskQueue();
    let confirm;
    queue.channelDelayed = {
      sendToQueue: jest.fn((_name, _content, _options, callback) => {
        confirm = callback;
      })
    };
    let settled = false;
    const persistence = queue.addDelayed({id: 'save'}, 1000, true);
    persistence.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(queue.channelDelayed.sendToQueue.mock.calls[0][2]).toEqual({persistent: true, expiration: '1000'});
    confirm(error);
    if (error) {
      await expect(persistence).rejects.toBe(error);
    } else {
      await expect(persistence).resolves.toBeUndefined();
    }
  });
});

// Exercise the production wrapper as well as the callback's exported entry point.
describe('document cleanup completion contract', () => {
  afterEach(() => jest.restoreAllMocks());

  test('final-viewer cleanup preserves the active claim and callback acceptance', async () => {
    const store = new EditorData();
    const accepted = {url: 'https://callback.example.test/save'};
    await store.setSaved(ctx, 'document', '1');
    await store.getdelSaved(ctx, 'document', 'save-key');
    await store.setSavedCallbackAccepted(ctx, 'document', 'save-key', accepted);
    await store.addForceSaveTimerNX(ctx, 'document', 1);
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockImplementation((...args) => store.cleanDocumentOnExit(...args));
    // Final-viewer cleanup has no ownership mask; argument six remains reserved
    // for the final-save callers that fence cleanup against a new session.
    jest.spyOn(taskResult, 'select').mockResolvedValue([]);

    await expect(docsCoServer.cleanDocumentAfterFinalViewerExitPromise(ctx, 'document')).resolves.toBe(true);

    expect(Object.hasOwn(store.data[ctx.tenant], 'document')).toBe(false);
    expect(await store.getForceSaveTimer(2)).toEqual([]);
    expect(await store.getdelSaved(ctx, 'document', 'save-key')).toBe('1');
    expect(await store.getSavedCallbackAccepted(ctx, 'document', 'save-key')).toEqual(accepted);
    await store.ackSaved(ctx, 'document', 'save-key');
    await store.clearSavedCallbackAccepted(ctx, 'document', 'save-key');
    expect(await store.getdelSaved(ctx, 'document', 'save-key')).toBeNull();
    expect(await store.getSavedCallbackAccepted(ctx, 'document', 'save-key')).toBeUndefined();
  });

  test('final-viewer cleanup never sends a WOPI unlock', async () => {
    // The last editor's final save may still hold the WOPI lock for its
    // PutFile; an unfenced UNLOCK from the last viewer's exit would race it.
    const store = new EditorData();
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockImplementation((...args) => store.cleanDocumentOnExit(...args));
    jest.spyOn(taskResult, 'select').mockResolvedValue([{callback: 'https://callback.example.test/save', baseurl: 'https://base.example.test/'}]);
    jest.spyOn(wopiClient, 'parseWopiCallback').mockReturnValue({
      userAuth: {wopiSrc: 'https://wopi.example.test/file', access_token: 'token', mode: 'edit'},
      commonInfo: {lockId: 'lock', fileInfo: {SupportsLocks: true}}
    });
    const unlock = jest.spyOn(wopiClient, 'unlock').mockResolvedValue(true);
    const openStart = jest.spyOn(canvasservice, 'commandOpenStartPromise').mockResolvedValue(undefined);

    await expect(docsCoServer.cleanDocumentAfterFinalViewerExitPromise(ctx, 'document')).resolves.toBe(true);

    expect(docsCoServer.editorData.cleanDocumentOnExit).toHaveBeenCalledWith(ctx, 'document', undefined, {preserveSavedClaim: true});
    expect(unlock).not.toHaveBeenCalled();
    expect(openStart).not.toHaveBeenCalled();
  });

  test.each([false, undefined, new Error('storage unavailable')])('stops destructive follow-up for %s', async result => {
    const clean = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');
    if (result instanceof Error) {
      clean.mockRejectedValue(result);
    } else {
      clean.mockResolvedValue(result);
    }
    const restore = jest.spyOn(taskResult, 'restoreInitialPassword');
    const removeChanges = jest.spyOn(sqlBase, 'deleteChangesPromise');
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
    const removeChanges = jest.spyOn(sqlBase, 'deleteChangesPromise').mockResolvedValue(undefined);
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    await expect(docsCoServer.cleanDocumentOnExitPromise(ctx, 'document', true, 1, 'save-key')).resolves.toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(removeChanges).toHaveBeenCalledWith(ctx, 'document', null);
    expect(removeFiles).toHaveBeenCalledTimes(1);
  });

  test.each([null, new Error('SQL deletion failed')])('keeps cleanup pending until the SQL callback: %s', async error => {
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const select = jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    let completeDeletion;
    const started = new Promise(resolve => {
      jest.spyOn(sqlConnector, 'sqlQuery').mockImplementation((_ctx, _sql, callback) => {
        completeDeletion = callback;
        resolve();
      });
    });

    let settled = false;
    const cleanup = docsCoServer.cleanDocumentOnExitPromise(ctx, 'document', true, 1, 'save-key');
    cleanup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const outcome = error ? expect(cleanup).rejects.toBe(error) : expect(cleanup).resolves.toBe(true);
    await started;
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(sqlBase.isLockCriticalSection('document')).toBe(true);
    expect(removeFiles).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    completeDeletion(error, {affectedRows: 1});
    await outcome;
    expect(sqlBase.isLockCriticalSection('document')).toBe(false);
    expect(removeFiles).toHaveBeenCalledTimes(error ? 0 : 1);
    expect(select).toHaveBeenCalledTimes(error ? 0 : 1);
  });
});

describe('SQL deletion critical section', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each(['completion', 'claim', 'password', 'remove', 'changes'])('compares the operation snapshot atomically in %s SQL', async action => {
    const additional = constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: "save-A'_%", phase: 'accepted'}});
    const mask = {tenant: ctx.tenant, key: 'document', status: 3, statusInfo: 2000000001, additional};
    const queries = [];
    const query = (_ctx, sql, callback, _raw, _noLog, values) => {
      queries.push({sql, values});
      callback(null, sql.startsWith('SELECT') ? [{password: 'newer-session-password'}] : {affectedRows: 0});
    };
    jest.spyOn(sqlBase, 'sqlQuery').mockImplementation(query);
    jest.spyOn(sqlConnector, 'sqlQuery').mockImplementation(query);
    if (sqlConnector.deleteChangesIf) {
      jest.spyOn(sqlConnector, 'deleteChangesIf').mockImplementation(async (_ctx, _docId, sql, values) => {
        queries.push({sql, values});
        return {affectedRows: 0};
      });
    }
    const update = {status: 3, statusInfo: 123};
    if (action === 'completion') {
      await taskResult.updateIf(ctx, update, mask);
    } else if (action === 'claim') {
      await taskResult.claimIf(ctx, update, mask);
    } else if (action === 'password') {
      jest.spyOn(sqlBase.DocumentPassword.prototype, 'getDocPassword').mockReturnValue({current: 'newer-session-password'});
      await taskResult.restoreInitialPassword(ctx, 'document', mask);
    } else if (action === 'remove') {
      await taskResult.removeIf(ctx, mask);
    } else {
      await taskResult.deleteChangesIf(ctx, mask);
    }
    const {sql, values} = queries.at(-1);
    const boundValues = values.map(value => value?.val ?? value);
    const parameter = sqlConnector.addSqlParameter(additional, Array(boundValues.indexOf(additional)));
    expect(boundValues).toContain(additional);
    expect(sql.slice(sql.indexOf(' WHERE '))).toContain(sqlBase.getAdditionalCondition(parameter));
    expect(sql).not.toContain(additional);
    expect(sql).not.toMatch(/WHERE.*additional=(?:CONCAT|COALESCE)/);
  });

  test('uses exact text comparison on each connector, including Oracle NCLOBs', () => {
    const mysql = require('../../DocService/sources/databaseConnectors/mysqlConnector');
    const mssql = require('../../DocService/sources/databaseConnectors/mssqlConnector');
    const oracle = require('../../DocService/sources/databaseConnectors/oracleConnector');
    expect(mysql.getAdditionalCondition('?')).toBe('CAST(additional AS BINARY)=CAST(? AS BINARY)');
    expect(mssql.getAdditionalCondition('@p')).toBe('additional COLLATE Latin1_General_100_BIN2=@p');
    expect(oracle.getAdditionalCondition(':0')).toBe('DBMS_LOB.COMPARE(additional, :0)=0');
  });

  test.each([null, new Error('SQL deletion failed')])('serializes legacy and awaited deletions and releases on %s', async error => {
    const callbacks = [];
    const query = jest.spyOn(sqlConnector, 'sqlQuery').mockImplementation((_ctx, _sql, callback) => {
      callbacks.push(callback);
    });
    sqlBase.deleteChanges(ctx, 'document', null);
    const first = sqlBase.deleteChangesPromise(ctx, 'document', 4);
    const outcome = error ? expect(first).rejects.toBe(error) : expect(first).resolves.toEqual({affectedRows: 1});
    const second = sqlBase.deleteChangesPromise(ctx, 'document', null);
    expect(query).toHaveBeenCalledTimes(1);
    expect(sqlBase.isLockCriticalSection('document')).toBe(true);

    callbacks[0](null, {affectedRows: 1});
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][5]).toEqual([ctx.tenant, 'document', 4]);
    callbacks[1](error, {affectedRows: 1});
    await outcome;
    expect(query).toHaveBeenCalledTimes(3);
    expect(sqlBase.isLockCriticalSection('document')).toBe(true);

    callbacks[2](null, {affectedRows: 2});
    await expect(second).resolves.toEqual({affectedRows: 2});
    expect(sqlBase.isLockCriticalSection('document')).toBe(false);
  });

  test('the ownership check of a conditional deletion locks the task row until the deletion commits', async () => {
    const query = jest.spyOn(sqlConnector, 'sqlQuery').mockImplementation((_ctx, _sql, callback) => callback(null, {affectedRows: 0}));
    const transaction = sqlConnector.deleteChangesIf ? jest.spyOn(sqlConnector, 'deleteChangesIf').mockResolvedValue({affectedRows: 0}) : null;
    await taskResult.deleteChangesIf(ctx, {tenant: ctx.tenant, key: 'document', status: 3, statusInfo: 2000000001});
    const sql = transaction ? transaction.mock.calls[0][2] : query.mock.calls[0][1];
    if (transaction) {
      expect(transaction).toHaveBeenCalledWith(ctx, 'document', sql, [3, 2000000001, ctx.tenant, 'document', ctx.tenant, 'document']);
      expect(query).not.toHaveBeenCalled();
    }
    expect(sql).toMatch(/^DELETE FROM \w+ WHERE EXISTS \(SELECT 1 FROM \w+/);
    // A snapshot read lets a takeover's hold land during the deletion (Postgres,
    // MSSQL with READ_COMMITTED_SNAPSHOT); MySQL and MariaDB lock DML subquery
    // reads by themselves; Oracle locks separately in the transaction helper.
    const lock = {postgreConnector: / FOR SHARE\)/, mssqlConnector: / WITH \(REPEATABLEREAD\) WHERE /}[sqlConnectorName];
    if (lock) {
      expect(sql).toMatch(lock);
    }
    const postgre = require('../../DocService/sources/databaseConnectors/postgreConnector');
    const mssql = require('../../DocService/sources/databaseConnectors/mssqlConnector');
    expect(postgre.getOwnershipCheck('t', 'c')).toBe('SELECT 1 FROM t WHERE c FOR SHARE');
    expect(mssql.getOwnershipCheck('t', 'c')).toBe('SELECT 1 FROM t WITH (REPEATABLEREAD) WHERE c');
  });

  test('rejects synchronous SQL errors and releases the critical section', async () => {
    const error = new Error('SQL connector failed');
    const query = jest.spyOn(sqlConnector, 'sqlQuery').mockImplementationOnce(() => {
      throw error;
    });
    await expect(sqlBase.deleteChangesPromise(ctx, 'document', null)).rejects.toBe(error);
    expect(sqlBase.isLockCriticalSection('document')).toBe(false);

    query.mockImplementationOnce((_ctx, _sql, callback) => callback(null, {affectedRows: 1}));
    await expect(sqlBase.deleteChangesPromise(ctx, 'document', null)).resolves.toEqual({affectedRows: 1});
  });
});
