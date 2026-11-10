/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {afterEach, describe, expect, jest, test} = require('@jest/globals');
const {randomUUID} = require('node:crypto');
const canvasservice = require('../../../DocService/sources/canvasservice');
const commonDefines = require('../../../Common/sources/commondefines');
const operationContext = require('../../../Common/sources/operationContext');
const sqlBase = require('../../../DocService/sources/databaseConnectors/baseConnector');
const taskResult = require('../../../DocService/sources/taskresult');
const storage = require('../../../Common/sources/storage/storage-base');
const constants = require('../../../Common/sources/constants');
const config = require('../../../Common/node_modules/config');
const docsCoServer = require('../../../DocService/sources/DocsCoServer');
const wopiClient = require('../../../DocService/sources/wopiClient');

const ctx = new operationContext.Context();
ctx.setTenant('cleanup-ownership-tests');
let docId;

function signal() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return {promise, resolve};
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('storage ownership lock coordination timed out')), 10000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeRowLock() {
  const type = config.get('services.CoAuthoring.sql.type');
  const table = config.get('services.CoAuthoring.sql.tableResult');
  if (type === 'mssql') {
    // Use a normal request so a deliberately rejected NOWAIT query does not
    // depend on the connector's prepared-statement failure cleanup.
    const mssql = require('../../../DocService/node_modules/mssql');
    const result = await new mssql.Request()
      .input('tenant', mssql.NVarChar, ctx.tenant)
      .input('id', mssql.NVarChar, docId)
      .query(`SELECT 1 FROM ${table} WITH (UPDLOCK, NOWAIT) WHERE tenant=@tenant AND id=@id`);
    return result.recordset;
  }
  const values = [];
  const tenant = sqlBase.addSqlParameter(ctx.tenant, values);
  const id = sqlBase.addSqlParameter(docId, values);
  const sql = `SELECT 1 FROM ${table} WHERE tenant=${tenant} AND id=${id} FOR UPDATE NOWAIT`;
  return new Promise((resolve, reject) => {
    sqlBase.sqlQuery(ctx, sql, (error, result) => (error ? reject(error) : resolve(result)), undefined, true, values);
  });
}

async function fixture() {
  docId = `cleanup-${randomUUID()}`;
  const task = new taskResult.TaskResultData();
  task.tenant = ctx.tenant;
  task.key = docId;
  task.status = commonDefines.FileStatus.SaveVersion;
  task.statusInfo = 12;
  task.callback = 'https://callback.example.test/save';
  task.baseurl = 'https://storage.example.test';
  await taskResult.upsert(ctx, task);
  await sqlBase.insertChangesPromise(ctx, [{change: 'original edit', time: new Date()}], docId, 0, {
    id: 'user',
    idOriginal: 'user',
    username: 'User'
  });
  return {tenant: ctx.tenant, key: docId, status: task.status, statusInfo: task.statusInfo};
}

afterEach(async () => {
  jest.restoreAllMocks();
  if (docId) {
    await sqlBase.deleteChangesPromise(ctx, docId, null);
    await taskResult.remove(ctx, docId);
    docId = undefined;
  }
});

describe('conditional document cleanup ownership', () => {
  test('supplies the verified task row to the ownership action', async () => {
    const mask = await fixture();
    const [expected] = await taskResult.select(ctx, docId);
    const action = jest.fn(async lockedRow => {
      expect(lockedRow).toEqual(expected);
    });

    await expect(taskResult.withCleanupOwnership(ctx, mask, action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  test('notification retries hold ownership through publication and release it after a publication failure', async () => {
    await fixture();
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      status: commonDefines.FileStatus.UpdateVersion,
      statusInfo: Math.floor(Date.now() / 60000),
      additional: constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: 'save-A', phase: 'accepted'}})
    });
    const cmd = new commonDefines.InputCommand({c: 'sfc', id: docId, savekey: 'save-A', updateVersionPending: true}, true);
    const error = new Error('publication unavailable');
    const publish = jest
      .spyOn(docsCoServer, 'publish')
      .mockImplementationOnce(async () => {
        await expect(probeRowLock()).rejects.toBeDefined();
        throw error;
      })
      .mockResolvedValue(undefined);

    await expect(canvasservice.commandSfcCallback(ctx, cmd, false, false)).rejects.toBe(error);
    // The failed attempt released the lock, and its serialized retry can still
    // notify editors waiting for the original save.
    await expect(probeRowLock()).resolves.toBeDefined();
    const retry = new commonDefines.InputCommand(JSON.parse(JSON.stringify(cmd)), true);
    await expect(canvasservice.commandSfcCallback(ctx, retry, false, false)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  test('a notification retry revalidates ownership after a concurrent open takes the row', async () => {
    await fixture();
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      status: commonDefines.FileStatus.UpdateVersion,
      statusInfo: Math.floor(Date.now() / 60000),
      additional: constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: 'save-A', phase: 'accepted'}})
    });
    const cmd = new commonDefines.InputCommand({c: 'sfc', id: docId, savekey: 'save-A', updateVersionPending: true}, true);
    const publish = jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    const withOwnership = taskResult.withCleanupOwnership;
    jest.spyOn(taskResult, 'withCleanupOwnership').mockImplementationOnce(async (...args) => {
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, status: commonDefines.FileStatus.Ok, statusInfo: 0});
      return withOwnership(...args);
    });

    await expect(canvasservice.commandSfcCallback(ctx, cmd, false, false)).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
    expect((await taskResult.select(ctx, docId))[0].status).toBe(commonDefines.FileStatus.Ok);
  });

  test('WOPI unlock holds ownership through the request and appends its marker without deadlocking', async () => {
    const mask = await fixture();
    const params = {commonInfo: {lockId: 'original-lock'}, userAuth: {mode: 'edit', access_token: 'original-token'}};
    jest.spyOn(wopiClient, 'parseWopiCallback').mockReturnValue(params);
    const entered = signal();
    const release = signal();
    jest.spyOn(wopiClient, 'unlock').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return true;
    });
    const unlock = docsCoServer.unlockWopiDoc(ctx, docId, 1, mask);
    try {
      await bounded(entered.promise);
      await expect(probeRowLock()).rejects.toBeDefined();
    } finally {
      release.resolve();
      await expect(bounded(unlock)).resolves.toBe(true);
    }

    const row = (await taskResult.select(ctx, docId))[0];
    expect(sqlBase.UserCallback.prototype.getCallbacks(ctx, row.callback)).toContain(wopiClient.getWopiUnlockMarker(params));
    expect(row.status).toBe(mask.status);
    expect(row.status_info).toBe(mask.statusInfo);
  });

  test.each(['takeover', 'removal'])('WOPI unlock conditionally appends its marker after concurrent %s', async action => {
    const mask = await fixture();
    jest.spyOn(wopiClient, 'parseWopiCallback').mockReturnValue({
      commonInfo: {lockId: 'original-lock'},
      userAuth: {mode: 'edit', access_token: 'original-token'}
    });
    const unlock = jest.spyOn(wopiClient, 'unlock').mockResolvedValue(true);
    const withOwnership = taskResult.withCleanupOwnership;
    jest.spyOn(taskResult, 'withCleanupOwnership').mockImplementationOnce(async (...args) => {
      const result = await withOwnership(...args);
      if (action === 'removal') {
        await taskResult.remove(ctx, docId);
      } else {
        await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, status: commonDefines.FileStatus.Ok, statusInfo: 0});
      }
      return result;
    });

    await expect(docsCoServer.unlockWopiDoc(ctx, docId, 1, mask)).resolves.toBe(false);

    expect(unlock).toHaveBeenCalledWith(ctx, expect.objectContaining({commonInfo: {lockId: 'original-lock'}}));
    const rows = await taskResult.select(ctx, docId);
    if (action === 'removal') {
      expect(rows).toHaveLength(0);
    } else {
      expect(rows[0].status).toBe(commonDefines.FileStatus.Ok);
      expect(rows[0].callback).not.toContain('unlockId');
    }
  });

  test.each([true, false])('takeover retries metadata-only SQL conflicts while retaining changes (%s)', async remaining => {
    await fixture();
    if (!remaining) {
      await sqlBase.deleteChangesPromise(ctx, docId, null);
    }
    const marker = constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: 'save-A', phase: 'accepted'}});
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      status: commonDefines.FileStatus.UpdateVersion,
      statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO,
      additional: marker
    });
    const [accepted] = await taskResult.select(ctx, docId);
    const updateIf = taskResult.updateIf;
    let appended = false;
    jest.spyOn(taskResult, 'updateIf').mockImplementation(async (...args) => {
      if (!appended) {
        appended = true;
        await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional: sqlBase.DocumentAdditional.prototype.setShardKey('before-hold')});
      }
      return updateIf(...args);
    });
    const getChanges = sqlBase.getChangesIndexPromise;
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockImplementationOnce(async (...args) => {
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional: sqlBase.DocumentAdditional.prototype.setShardKey('after-hold')});
      return getChanges(...args);
    });
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);

    const expected = remaining ? commonDefines.FileStatus.Ok : commonDefines.FileStatus.None;
    await expect(canvasservice.takeOverAbandonedSaveForOpen(ctx, docId, accepted)).resolves.toBe(expected);

    const [result] = await taskResult.select(ctx, docId);
    expect(result.status).toBe(expected);
    expect(result.additional).toContain('before-hold');
    expect(result.additional).toContain('after-hold');
    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(remaining ? 1 : 0);
    expect(removeFiles).toHaveBeenCalledTimes(remaining ? 0 : 1);
  });

  test.each([false, true])(
    'holds ownership through storage and releases the database lock (failure: %s)',
    async failed => {
      const mask = await fixture();
      const additional = constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: 'save-A', phase: 'accepted'}});
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional});
      mask.additional = (await taskResult.select(ctx, docId))[0].additional;
      const entered = signal();
      const release = signal();
      const failure = new Error('storage deletion failed');
      const cleanup = taskResult.withCleanupOwnership(ctx, mask, async () => {
        entered.resolve();
        await bounded(release.promise);
        if (failed) {
          throw failure;
        }
      });
      cleanup.catch(() => {});
      try {
        await bounded(entered.promise);
        const lockError = {
          postgres: {code: '55P03'},
          mysql: {errno: 3572},
          mariadb: {errno: 1205},
          mssql: {number: 1222},
          oracle: {errorNum: 54}
        }[config.get('services.CoAuthoring.sql.type')];
        // An independent connection cannot acquire an update lock while the
        // storage action is pending. A takeover UPDATE must wait as well.
        await expect(bounded(probeRowLock())).rejects.toMatchObject(lockError);
      } finally {
        release.resolve();
        await bounded(cleanup.catch(() => {}));
      }
      if (failed) {
        await expect(cleanup).rejects.toBe(failure);
      } else {
        await expect(cleanup).resolves.toBe(true);
      }
      await expect(probeRowLock()).resolves.toHaveLength(1);
      const action = jest.fn().mockResolvedValue(undefined);
      await expect(taskResult.withCleanupOwnership(ctx, mask, action)).resolves.toBe(true);
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional: constants.CHAR_DELIMITER + JSON.stringify({newOwner: true})});
      await expect(taskResult.withCleanupOwnership(ctx, mask, action)).resolves.toBe(false);
      expect(action).toHaveBeenCalledTimes(1);
    },
    30000
  );

  test('a new session waits for a forgotten-file copy and fences later copies', async () => {
    const mask = await fixture();
    const additional = constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: 'save-A', phase: 'declined'}});
    await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional});
    mask.additional = (await taskResult.select(ctx, docId))[0].additional;
    const copying = signal();
    const release = signal();
    let copied = false;
    jest.spyOn(storage, 'copyObject').mockImplementation(async () => {
      copying.resolve();
      await bounded(release.promise);
      copied = true;
    });
    const copyForgottenFile = () => storage.copyObject(ctx, `${docId}/output.docx`, `${docId}/forgotten.docx`);
    const copy = taskResult.withCleanupOwnership(ctx, mask, copyForgottenFile);
    copy.catch(() => {});
    let open;
    try {
      await bounded(copying.promise);
      let opened = false;
      open = taskResult.updateIf(ctx, {status: commonDefines.FileStatus.Ok, statusInfo: constants.NO_ERROR}, mask).then(result => {
        opened = true;
        expect(copied).toBe(true);
        return result;
      });
      open.catch(() => {});
      await expect(bounded(probeRowLock())).rejects.toBeDefined();
      expect(opened).toBe(false);
    } finally {
      release.resolve();
      await bounded(Promise.all([copy, open]));
    }
    expect((await open).affectedRows).toBe(1);
    const accepted = constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId: 'save-B', phase: 'accepted'}});
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      status: commonDefines.FileStatus.UpdateVersion,
      statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO,
      additional: accepted
    });
    await expect(taskResult.withCleanupOwnership(ctx, mask, copyForgottenFile)).resolves.toBe(false);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
  });

  test.each([0, 40000])('a newer accepted operation fences stale SQL mutations (metadata padding: %i)', async padding => {
    const mask = await fixture();
    const marker = operationId => constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId, phase: 'accepted'}});
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      status: commonDefines.FileStatus.UpdateVersion,
      statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO,
      additional: constants.CHAR_DELIMITER + JSON.stringify({padding: 'é'.repeat(padding)}) + marker('save-A'),
      password: 'initial-password'
    });
    const [acceptedA] = await taskResult.select(ctx, docId);
    Object.assign(mask, {status: acceptedA.status, statusInfo: acceptedA.status_info, additional: acceptedA.additional});
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      additional: marker('save-B'),
      password: 'save-B-password',
      innerPasswordChange: 'user'
    });
    const [acceptedB] = await taskResult.select(ctx, docId);

    expect((await taskResult.deleteChangesIf(ctx, mask)).affectedRows).toBe(0);
    const removeFiles = jest.fn().mockResolvedValue(undefined);
    await expect(taskResult.withCleanupOwnership(ctx, mask, removeFiles)).resolves.toBe(false);
    expect(removeFiles).not.toHaveBeenCalled();
    expect((await taskResult.restoreInitialPassword(ctx, docId, mask)).affectedRows).toBe(0);
    expect((await taskResult.updateIf(ctx, {statusInfo: 123}, mask)).affectedRows).toBe(0);
    expect((await taskResult.removeIf(ctx, mask)).affectedRows).toBe(0);
    expect((await taskResult.select(ctx, docId))[0]).toMatchObject({
      status: acceptedB.status,
      status_info: acceptedB.status_info,
      additional: acceptedB.additional,
      password: acceptedB.password
    });
    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);

    // The current operation can still retry its own cleanup.
    const currentMask = {...mask, additional: acceptedB.additional};
    await expect(taskResult.withCleanupOwnership(ctx, currentMask, removeFiles)).resolves.toBe(true);
    expect(removeFiles).toHaveBeenCalledTimes(1);
    await taskResult.restoreInitialPassword(ctx, docId, currentMask);
    expect(sqlBase.DocumentPassword.prototype.getCurPassword(ctx, (await taskResult.select(ctx, docId))[0].password)).toBe('initial-password');
    expect((await taskResult.deleteChangesIf(ctx, currentMask)).affectedRows).toBe(1);
    expect((await taskResult.deleteChangesIf(ctx, currentMask)).affectedRows).toBe(0);
    expect((await taskResult.removeIf(ctx, currentMask)).affectedRows).toBe(1);
  });

  test('a reused cache cleanup claim cannot delete the newer operation', async () => {
    const mask = await fixture();
    const marker = operationId => constants.CHAR_DELIMITER + JSON.stringify({sfcFinalSave: {operationId, phase: 'declined'}});
    await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional: marker('save-A')});
    mask.additional = (await taskResult.select(ctx, docId))[0].additional;
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const deleteChanges = sqlBase.deleteChangesPromise;
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockImplementationOnce(async (...args) => {
      // The replacement claim has the same status and status_info as A's.
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, additional: marker('save-B')});
      return deleteChanges(...args);
    });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);
    expect(removeFiles).not.toHaveBeenCalled();
    expect((await taskResult.select(ctx, docId))[0].additional).toContain('save-B');
  });

  test.each(['reopened', 'newer save'])('preserves changes and cache when the original task no longer owns cleanup (%s)', async scenario => {
    const mask = await fixture();
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    await taskResult.update(ctx, {
      tenant: ctx.tenant,
      key: docId,
      status: scenario === 'reopened' ? commonDefines.FileStatus.Ok : commonDefines.FileStatus.SaveVersion,
      statusInfo: scenario === 'reopened' ? 0 : 13
    });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);
    expect(removeFiles).not.toHaveBeenCalled();
    expect(await taskResult.select(ctx, docId)).toHaveLength(1);
  });

  test('treats a missing task row as completed cleanup', async () => {
    const mask = await fixture();
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    await taskResult.remove(ctx, docId);

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(true);

    const action = jest.fn();
    await expect(taskResult.withCleanupOwnership(ctx, mask, action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();

    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);
    expect(removeFiles).not.toHaveBeenCalled();
    expect(await taskResult.select(ctx, docId)).toHaveLength(0);
  });

  test('rechecks ownership inside SQL deletion when the session changes after cleanup begins', async () => {
    const mask = await fixture();
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const deleteChanges = sqlBase.deleteChangesPromise;
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockImplementationOnce(async (...args) => {
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, status: commonDefines.FileStatus.Ok, statusInfo: 0});
      return deleteChanges(...args);
    });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);
    expect(removeFiles).not.toHaveBeenCalled();
    expect((await taskResult.select(ctx, docId))[0].status).toBe(commonDefines.FileStatus.Ok);
  });

  test('retains callback metadata after SQL failure and completes cleanup on retry', async () => {
    const mask = await fixture();
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const error = new Error('SQL deletion failed');
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockRejectedValueOnce(error);

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).rejects.toBe(error);
    const rows = await taskResult.select(ctx, docId);
    expect(rows).toHaveLength(1);
    expect(rows[0].callback).toContain('callback.example.test');
    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);
    expect(removeFiles).not.toHaveBeenCalled();

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(true);

    expect(await taskResult.select(ctx, docId)).toHaveLength(0);
    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(0);
    expect(removeFiles).toHaveBeenCalledTimes(1);
  });

  test('preserves a session opened between change deletion and conditional task removal', async () => {
    const mask = await fixture();
    const removeFiles = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const withOwnership = taskResult.withCleanupOwnership;
    jest.spyOn(taskResult, 'withCleanupOwnership').mockImplementationOnce(async (...args) => {
      await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, status: commonDefines.FileStatus.Ok, statusInfo: 0});
      await sqlBase.insertChangesPromise(ctx, [{change: 'new session edit', time: new Date()}], docId, 0, {
        id: 'new-user',
        idOriginal: 'new-user',
        username: 'New User'
      });
      return withOwnership(...args);
    });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    const changes = await sqlBase.getChangesPromise(ctx, docId);
    expect(changes).toHaveLength(1);
    expect(changes[0].change_data.toString()).toBe('new session edit');
    expect(removeFiles).not.toHaveBeenCalled();
    expect((await taskResult.select(ctx, docId))[0].status).toBe(commonDefines.FileStatus.Ok);
  });
});
