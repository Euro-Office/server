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

const ctx = new operationContext.Context();
ctx.setTenant('cleanup-ownership-tests');
let docId;

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
    const select = taskResult.select;
    jest
      .spyOn(taskResult, 'select')
      .mockImplementationOnce((...args) => select(...args))
      .mockImplementationOnce(async (...args) => {
        await taskResult.update(ctx, {tenant: ctx.tenant, key: docId, status: commonDefines.FileStatus.Ok, statusInfo: 0});
        await sqlBase.insertChangesPromise(ctx, [{change: 'new session edit', time: new Date()}], docId, 0, {
          id: 'new-user',
          idOriginal: 'new-user',
          username: 'New User'
        });
        return select(...args);
      });

    await expect(canvasservice.cleanupCacheIf(ctx, mask)).resolves.toBe(false);

    const changes = await sqlBase.getChangesPromise(ctx, docId);
    expect(changes).toHaveLength(1);
    expect(changes[0].change_data.toString()).toBe('new session edit');
    expect(removeFiles).not.toHaveBeenCalled();
    expect((await taskResult.select(ctx, docId))[0].status).toBe(commonDefines.FileStatus.Ok);
  });
});
