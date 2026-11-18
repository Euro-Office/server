/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Final-save retries driven through receiveTask against a task row that
// behaves like the SQL: conditional updates honour the mask, `additional` is
// appended (`COALESCE(additional, '') || $n`), and the clock moves between
// deliveries. Every scenario must end in a completed save or a logged give-up.

const util = require('node:util');
const Queue = require('../../Common/sources/taskqueueRabbitMQ');
const rabbitCore = require('../../Common/sources/rabbitMQCore');
const {rabbit} = require('./helpers/queueBroker');
const {afterEach, beforeEach, describe, expect, jest, test} = require('@jest/globals');
const canvasservice = require('../../DocService/sources/canvasservice');
const commonDefines = require('../../Common/sources/commondefines');
const constants = require('../../Common/sources/constants');
const docsCoServer = require('../../DocService/sources/DocsCoServer');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const storage = require('../../Common/sources/storage/storage-base');
const taskResult = require('../../DocService/sources/taskresult');
const wopiClient = require('../../DocService/sources/wopiClient');
const wopiUtils = require('../../DocService/sources/wopiUtils');
const utils = require('../../Common/sources/utils');
const config = require('../../Common/node_modules/config');
const log4js = require('../../Common/node_modules/log4js');
const operationContext = require('../../Common/sources/operationContext');

const DOC_ID = 'document';
const MARKER = 'sfcFinalSave';
const {UpdateVersion, SaveVersion, Ok} = commonDefines.FileStatus;
const LoggerPrototype = Object.getPrototypeOf(log4js.getLogger('sfc-retry-tests'));

let caseId = 0;
let tenant;
let now;
let row;
let delayed;
let errors;
let changesLeft;
let cleanupWait;

function minute() {
  return Math.floor(now / 60000);
}
function cleanupBarrier() {
  let entered, release;
  const started = new Promise(resolve => (entered = resolve));
  const pending = new Promise(resolve => (release = resolve));
  return {
    started,
    release,
    pause: async () => {
      entered();
      await pending;
    }
  };
}
function additionalEntries() {
  if (!row?.additional) {
    return [];
  }
  return row.additional
    .split(constants.CHAR_DELIMITER)
    .slice(1)
    .map(item => JSON.parse(item));
}
function finalSaveMarkers() {
  return additionalEntries()
    .filter(item => item[MARKER])
    .map(item => item[MARKER]);
}
function rowMatches(mask) {
  if (!row) {
    return false;
  }
  if (mask.status !== undefined && mask.status !== null && row.status !== mask.status) {
    return false;
  }
  if (mask.statusInfo !== undefined && mask.statusInfo !== null && row.status_info !== mask.statusInfo) {
    return false;
  }
  if (mask.additional !== undefined && mask.additional !== null && row.additional !== mask.additional) {
    return false;
  }
  return true;
}
function updateRow(task, mask, updateTime = true) {
  if (!rowMatches(mask)) {
    return {affectedRows: 0};
  }
  if (task.status !== undefined && task.status !== null) {
    row.status = task.status;
  }
  if (task.statusInfo !== undefined && task.statusInfo !== null) {
    row.status_info = task.statusInfo;
  }
  if (updateTime) {
    row.last_open_date = new Date(now);
  }
  if (task.additional !== undefined && task.additional !== null) {
    row.additional = task.replaceAdditional ? task.additional : (row.additional || '') + task.additional;
  }
  if (task.callback) {
    const callback = new sqlBase.UserCallback();
    callback.fromValues(task.indexUser, task.callback);
    row.callback += callback.toSQLInsert();
  }
  return {affectedRows: 1};
}
function command(overrides = {}) {
  return new commonDefines.InputCommand({
    c: 'sfc',
    id: DOC_ID,
    userid: 'user',
    userindex: 1,
    status_info: constants.NO_ERROR,
    status_info_in: 12,
    savekey: 'save-key',
    outputpath: 'output.docx',
    ...overrides
  });
}
function queued(overrides = {}) {
  const task = new commonDefines.TaskQueueData();
  task.setCtx({tenant, docId: DOC_ID, userId: 'user'});
  task.setCmd(command(overrides));
  return JSON.stringify(task);
}
async function deliver(data) {
  const ack = jest.fn();
  await canvasservice.receiveTask(data, ack);
  return {ack};
}
// Deliver queued retries the way the delayed queue does: after their TTL,
// plus `extraMs` to move the retry into a later minute.
async function drainRetries({limit = 10, extraMs = 0} = {}) {
  let deliveries = 0;
  while (delayed.length > 0 && deliveries < limit) {
    const {data, ttl} = delayed.shift();
    now += ttl + extraMs;
    const {ack} = await deliver(data);
    expect(ack).toHaveBeenCalledTimes(1);
    deliveries++;
  }
  return deliveries;
}
// Millisecond backoff delays, so that tests can wait out in-process retries.
function useFastBackoff() {
  const options = config.get('services.CoAuthoring.callbackBackoffOptions');
  const fast = {...options, timeout: {...options.timeout, minTimeout: 1}};
  operationContext.Context.prototype.getCfg.mockImplementation((path, fallback) =>
    path === 'services.CoAuthoring.callbackBackoffOptions' ? fast : fallback
  );
}
// A newer save of a reopened document moves the row to UpdateVersion and, in
// the same write, names itself on it.
function newerSaveTakesRow() {
  row.status = UpdateVersion;
  row.status_info = minute();
  const data = new sqlBase.DocumentAdditional();
  data.data.push({[MARKER]: {operationId: 'newer-save', phase: 'sending', openFromForgotten: false, since: now}});
  row.additional = (row.additional || '') + data.toSQLInsert();
}
// Completed: the accepted marker stays, the pending status is released.
function expectCompleted(operationId = 'save-key') {
  expect(row.status).toBe(UpdateVersion);
  expect(row.status_info).toBeLessThan(commonDefines.FINAL_SAVE_PENDING_STATUS_INFO);
  expect(finalSaveMarkers()).toContainEqual(expect.objectContaining({operationId, phase: 'accepted'}));
}
function fakeWopiHost({tokenValid = true} = {}) {
  const host = {locked: true, tokenValid, puts: 0, unlocks: 0};
  jest.spyOn(wopiClient, 'parseWopiCallback').mockReturnValue({
    userAuth: {wopiSrc: 'https://wopi.example.test/wopi/files/1', access_token: 'token', mode: 'edit'},
    commonInfo: {lockId: 'lock', fileInfo: {SupportsLocks: true, SupportsUpdate: true, BaseFileName: 'document.docx'}}
  });
  jest.spyOn(utils, 'checkHostFilter').mockImplementation(function* () {
    yield Promise.resolve();
    return 0;
  });
  jest.spyOn(wopiUtils, 'fillStandardHeaders').mockResolvedValue(undefined);
  jest.spyOn(canvasservice, 'commandOpenStartPromise').mockResolvedValue(undefined);
  jest.spyOn(storage, 'headObject').mockResolvedValue({ContentLength: 1});
  jest.spyOn(storage, 'createReadStream').mockResolvedValue({readStream: {}});
  jest.spyOn(utils, 'postRequestPromise').mockImplementation(async (...args) => {
    const override = args[8]['X-WOPI-Override'];
    const reject = statusCode => {
      throw Object.assign(new Error(`WOPI ${override} ${statusCode}`), {statusCode});
    };
    if ('PUT' === override) {
      host.puts++;
    } else if ('UNLOCK' === override) {
      host.unlocks++;
    } else {
      throw new Error(`unexpected WOPI request ${override}`);
    }
    if (!host.tokenValid) {
      reject(401);
    }
    if (!host.locked) {
      reject(409);
    }
    if ('UNLOCK' === override) {
      host.locked = false;
    }
    return {response: {headers: {}}, body: ''};
  });
  return host;
}

describe('final-save retries converge', () => {
  beforeEach(() => {
    tenant = `sfc-retry-${++caseId}`;
    now = Date.UTC(2026, 10, 3, 12, 0, 10);
    delayed = [];
    errors = [];
    changesLeft = true;
    cleanupWait = Promise.resolve();
    row = {
      tenant,
      id: DOC_ID,
      callback: 'https://callback.example.test/save',
      baseurl: 'https://storage.example.test',
      status: SaveVersion,
      status_info: 12,
      last_open_date: new Date(now - 60000),
      additional:
        sqlBase.DocumentAdditional.prototype.setOpenedAt(now - 60000, 0, 'ff0000') + sqlBase.DocumentAdditional.prototype.setShardKey('shard-1')
    };
    docsCoServer.editorData.savedClaims = {};
    docsCoServer.editorData.savedCallbackAccepted = {};

    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(operationContext.Context.prototype, 'initTenantCache').mockResolvedValue(undefined);
    jest.spyOn(operationContext.Context.prototype, 'getCfg').mockImplementation((_path, fallback) => fallback);
    for (const level of ['trace', 'debug', 'info', 'warn']) {
      jest.spyOn(LoggerPrototype, level).mockImplementation(() => {});
    }
    jest.spyOn(LoggerPrototype, 'error').mockImplementation((...args) => errors.push(util.format(...args)));

    jest.spyOn(taskResult, 'select').mockImplementation(async (_ctx, id) => (row && id === DOC_ID ? [{...row}] : []));
    jest.spyOn(taskResult, 'update').mockResolvedValue({affectedRows: 1});
    jest.spyOn(taskResult, 'updateIf').mockImplementation(async (_ctx, task, mask, updateTime = true) => {
      await cleanupWait;
      return updateRow(task, mask, updateTime);
    });
    jest.spyOn(taskResult, 'claimIf').mockImplementation(async (_ctx, task, mask) => {
      await cleanupWait;
      return updateRow(task, mask, false);
    });
    jest.spyOn(taskResult, 'withCleanupOwnership').mockImplementation(async (_ctx, mask, action) => {
      await cleanupWait;
      if (!rowMatches(mask)) {
        return false;
      }
      let release;
      cleanupWait = new Promise(resolve => (release = resolve));
      try {
        await action({...row});
        return true;
      } finally {
        release();
      }
    });
    jest.spyOn(taskResult, 'deleteChangesIf').mockImplementation(async (_ctx, mask) => {
      await cleanupWait;
      if (!rowMatches(mask)) {
        return {affectedRows: 0};
      }
      changesLeft = false;
      return {affectedRows: 1};
    });
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockImplementation(async () => [{change_id: changesLeft ? 3 : null}]);
    jest.spyOn(taskResult, 'removeIf').mockImplementation(async (_ctx, mask) => {
      await cleanupWait;
      if (!rowMatches(mask)) {
        return {affectedRows: 0};
      }
      row = null;
      return {affectedRows: 1};
    });
    jest.spyOn(taskResult, 'remove').mockImplementation(async () => {
      const affectedRows = row ? 1 : 0;
      row = null;
      return {affectedRows};
    });
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockImplementation(async () => {
      changesLeft = false;
      return {affectedRows: 1};
    });
    jest.spyOn(sqlBase.UserCallback.prototype, 'getCallbackByUserIndex').mockReturnValue('https://callback.example.test/save');
    jest.spyOn(wopiClient, 'parseWopiCallback').mockReturnValue(null);

    jest.spyOn(storage, 'listObjects').mockResolvedValue([]);
    jest.spyOn(storage, 'getObject').mockResolvedValue(Buffer.from('{}'));
    jest.spyOn(storage, 'getSignedUrl').mockResolvedValue('https://storage.example.test/signed');
    jest.spyOn(storage, 'copyObject').mockResolvedValue(undefined);
    jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);

    jest.spyOn(docsCoServer, 'getEditorsCountPromise').mockResolvedValue(0);
    jest.spyOn(docsCoServer.editorData, 'getForceSave').mockResolvedValue(null);
    jest.spyOn(docsCoServer, 'sendServerRequest').mockResolvedValue('{"error":0}');
    jest.spyOn(docsCoServer, 'publish').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer, 'getIsShutdown').mockReturnValue(false);
    jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* (task, ttl) {
      yield Promise.resolve();
      delayed.push({data: JSON.stringify(task), ttl});
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([false, true])('initial-claim metadata conflicts retry without dropping the save (older marker: %s)', async olderMarker => {
    if (olderMarker) {
      await deliver(queued());
      expectCompleted();
      row.status = SaveVersion;
      row.status_info = 12;
      changesLeft = true;
      docsCoServer.sendServerRequest.mockClear();
    }
    const updateIf = taskResult.updateIf.getMockImplementation();
    let appended = false;
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      if (!appended && mask.status === SaveVersion && task.status === UpdateVersion) {
        appended = true;
        row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('appended-meanwhile');
      }
      return updateIf(ctx, task, mask, updateTime);
    });

    const {ack} = await deliver(queued({savekey: 'save-B'}));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(1);
    expect(docsCoServer.sendServerRequest).not.toHaveBeenCalled();
    expect(changesLeft).toBe(true);
    expect(await drainRetries()).toBe(1);
    expectCompleted('save-B');
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(changesLeft).toBe(false);
  });

  test.each([false, true])('metadata appended after cleanup retries completion (from forgotten: %s)', async fromForgotten => {
    if (fromForgotten) {
      storage.listObjects.mockImplementation(async (_ctx, path) =>
        path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']
      );
    }
    const clean = docsCoServer.cleanDocumentOnExitPromise;
    let appended = false;
    jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockImplementation(async (...args) => {
      const result = await clean(...args);
      if (!appended) {
        appended = true;
        row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('appended-meanwhile');
      }
      return result;
    });

    await deliver(queued());

    expect(delayed).toHaveLength(1);
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(await drainRetries()).toBe(1);
    if (fromForgotten) {
      expect(row).toBeNull();
    } else {
      expectCompleted();
      expect(additionalEntries()).toContainEqual({shardKey: 'appended-meanwhile'});
    }
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test.each(['forgotten files', 'cache', 'forgotten completion'])('takeover waits for in-flight %s deletion', async stage => {
    const deleting = cleanupBarrier();
    const cleaningB = cleanupBarrier();
    let notifyTakeover;
    const submitted = new Promise(resolve => (notifyTakeover = resolve));
    if (stage === 'cache') {
      docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    } else if (stage === 'forgotten completion') {
      storage.listObjects.mockImplementation(async (_ctx, path) =>
        path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']
      );
    }
    const files = new Set(['old-file']);
    let paused = false;
    storage.deletePath.mockImplementation(async (_ctx, _docId, prefix) => {
      if (!paused && (stage === 'forgotten files' ? prefix !== undefined : prefix === undefined)) {
        paused = true;
        await deleting.pause();
        files.clear();
      }
    });
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (...args) => {
      if (args[1].statusInfo === commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO) {
        notifyTakeover();
      }
      return updateIf(...args);
    });
    const initialRow = {...row};
    const saveA = deliver(queued());
    let takeover, saveB;
    try {
      await deleting.started;
      const ctx = new operationContext.Context();
      ctx.setTenant(tenant);
      now += 86400000;
      let tookOver = false;
      takeover = canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row}).then(result => {
        tookOver = true;
        return result;
      });
      await submitted;
      await new Promise(setImmediate);
      expect(tookOver).toBe(false);
      expect(files).toEqual(new Set(['old-file']));

      deleting.release();
      await Promise.all([saveA, takeover]);
      expect(files.size).toBe(0);
      row = {...(row || initialRow), status: SaveVersion, status_info: 12};
      changesLeft = true;
      files.add('new-session-file');
      docsCoServer.sendServerRequest.mockResolvedValue('{"error":0}');
      const clean = docsCoServer.cleanDocumentOnExitPromise;
      jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockImplementation(async (...args) => {
        await cleaningB.pause();
        return clean(...args);
      });
      saveB = deliver(queued({savekey: 'save-B'}));
      await cleaningB.started;
      const pendingB = {...row};
      await drainRetries();
      expect(row).toEqual(pendingB);
      expect(changesLeft).toBe(true);
      expect(files).toEqual(new Set(['new-session-file']));
    } finally {
      deleting.release();
      cleaningB.release();
      await Promise.all([saveA, takeover, saveB]);
    }
  });

  test('a new session waits for an in-flight forgotten-file copy', async () => {
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('1').mockResolvedValueOnce('0');
    const copying = cleanupBarrier();
    let forgottenFile;
    storage.copyObject.mockImplementationOnce(async () => {
      await copying.pause();
      forgottenFile = 'save-A';
    });
    const saveA = deliver(queued());
    let reopen;
    try {
      await copying.started;
      expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-key', phase: 'declined'}));
      const ctx = new operationContext.Context();
      ctx.setTenant(tenant);
      let reopened = false;
      reopen = taskResult
        .updateIf(
          ctx,
          {status: Ok, statusInfo: constants.NO_ERROR},
          {
            tenant,
            key: DOC_ID,
            status: SaveVersion,
            statusInfo: 12,
            additional: row.additional
          }
        )
        .then(result => {
          reopened = true;
          return result;
        });
      await new Promise(setImmediate);
      expect(reopened).toBe(false);
      expect(forgottenFile).toBeUndefined();
      copying.release();
      expect((await reopen).affectedRows).toBe(1);
      await saveA;
      const retriesA = delayed.splice(0);
      row.status = SaveVersion;
      row.status_info = 12;
      changesLeft = true;
      taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('pause B cleanup'));
      await deliver(queued({savekey: 'save-B'}));
      const pendingB = {...row};
      forgottenFile = 'save-B';
      for (const retryA of retriesA) {
        await deliver(retryA.data);
      }
      expect(row).toEqual(pendingB);
      expect(forgottenFile).toBe('save-B');
      expect(storage.copyObject).toHaveBeenCalledTimes(1);
    } finally {
      copying.release();
      await Promise.all([saveA, reopen]);
    }
  });

  test.each(['newer save', 'metadata'])('a forgotten-file copy rechecks ownership after %s changes', async change => {
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    let interrupted = false;
    let newerRow;
    taskResult.withCleanupOwnership.mockImplementation(async (...args) => {
      if (!interrupted) {
        interrupted = true;
        if (change === 'newer save') {
          newerSaveTakesRow();
          row.status_info = commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
          const additional = new sqlBase.DocumentAdditional();
          additional.data.push({[MARKER]: {operationId: 'newer-save', phase: 'accepted', since: now}});
          row.additional += additional.toSQLInsert();
          newerRow = {...row};
        } else {
          row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('before-forgotten-copy');
        }
      }
      return withOwnership(...args);
    });

    await deliver(queued());

    expect(storage.copyObject).not.toHaveBeenCalled();
    if (change === 'newer save') {
      expect(row).toEqual(newerRow);
      expect(delayed).toHaveLength(0);
      expect(taskResult.deleteChangesIf).not.toHaveBeenCalled();
      expect(docsCoServer.publish).not.toHaveBeenCalled();
    } else {
      expect(delayed).toHaveLength(1);
      await drainRetries();
      expect(storage.copyObject).toHaveBeenCalledTimes(1);
      expect(row).toBeNull();
      expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    }
  });

  test('a first-attempt success releases its pending status and leaves one marker', async () => {
    const {ack} = await deliver(queued());

    expect(ack).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
    expectCompleted();
    expect(row.status_info).toBe(minute());
    // `additional` is appended in SQL: one marker per write of this save
    // (taking the row, then accepting), nothing else.
    const entries = additionalEntries();
    expect(entries.filter(item => item.shardKey)).toHaveLength(1);
    expect(entries.filter(item => undefined !== item.timezoneOffset)).toHaveLength(1);
    expect(finalSaveMarkers()).toEqual([
      expect.objectContaining({operationId: 'save-key', phase: 'sending', since: expect.any(Number)}),
      expect.objectContaining({operationId: 'save-key', phase: 'accepted', since: expect.any(Number)})
    ]);
    // The changes go only while the row still holds this save's status.
    expect(taskResult.deleteChangesIf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({status: UpdateVersion, statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO})
    );
    expect(sqlBase.deleteChangesPromise).not.toHaveBeenCalled();
    expect(canvasservice.hasAdditionalCol).toBe(true);
  });

  test('every encrypted save of an open document sends its callback', async () => {
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    docsCoServer.getEditorsCountPromise.mockResolvedValue(1);
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);

    const replies = [];
    for (let i = 1; i <= 4; ++i) {
      now += 30000;
      replies.push(await canvasservice.commandSfcCallback(ctx, command({savekey: `save-${i}`}), false, true));
    }

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(4);
    expect(replies).toEqual(['{"error":0}', '{"error":0}', '{"error":0}', '{"error":0}']);
    // Encrypted saves are answered synchronously and never retried: no
    // acceptance tracking, the row keeps the minute.
    expect(row.status).toBe(UpdateVersion);
    expect(row.status_info).toBe(minute());
    expect(finalSaveMarkers()).toEqual([]);
  });

  test.each([
    ['503', Object.assign(new Error('callback unavailable'), {statusCode: 503}), 61000],
    ['timeout', Object.assign(new Error('ESOCKETTIMEDOUT'), {code: 'ESOCKETTIMEDOUT'}), 10 * 60000]
  ])('a callback %s retried in a later minute completes after one retry', async (_name, error, extraMs) => {
    docsCoServer.sendServerRequest.mockRejectedValueOnce(error);

    await deliver(queued());
    // A callback that was not accepted restores the row.
    expect(row.status).toBe(SaveVersion);
    expect(row.status_info).toBe(12);
    expect(delayed).toHaveLength(1);

    expect(await drainRetries({extraMs})).toBe(1);
    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
    expectCompleted();
  });

  test('a delivery redelivered after the worker died past the UpdateVersion write completes', async () => {
    row.status = UpdateVersion;
    row.status_info = minute();
    now += 90000;

    const {ack} = await deliver(queued());

    expect(ack).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expectCompleted();
  });

  test('a declined save removes the task row and stores the forgotten file', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');

    await deliver(queued());

    expect(delayed).toHaveLength(0);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(row).toBeNull();
    expect(docsCoServer.publish).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({success: false}));
  });

  test('a declined callback is sent once while its forgotten copy is retried', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));

    await deliver(queued());
    expect(delayed).toHaveLength(1);
    expect(await drainRetries()).toBe(1);

    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(2);
    expect(row).toBeNull();
    expect(docsCoServer.publish).toHaveBeenCalledTimes(1);
  });

  test('WOPI: takeover after storage cleanup cannot unlock the newer session', async () => {
    fakeWopiHost();
    const unlock = jest.spyOn(wopiClient, 'unlock').mockResolvedValue(true);
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    const mask = {tenant, key: DOC_ID, status: row.status, statusInfo: row.status_info, additional: row.additional};
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementationOnce(async (...args) => {
      const result = await withOwnership(...args);
      newerSaveTakesRow();
      row.callback = 'new session callback';
      wopiClient.parseWopiCallback.mockReturnValue({
        commonInfo: {lockId: 'new-lock'},
        userAuth: {access_token: 'new-token', mode: 'edit'}
      });
      return result;
    });

    await expect(docsCoServer.cleanDocumentOnExitPromise(ctx, DOC_ID, true, 1, undefined, mask)).resolves.toBe(false);

    expect(unlock).not.toHaveBeenCalled();
    expect(row.callback).toBe('new session callback');
    expect(canvasservice.commandOpenStartPromise).not.toHaveBeenCalled();
  });

  test.each(['newer save', 'removed row'])('WOPI: the unlock marker cannot overwrite a %s after UNLOCK', async takeover => {
    fakeWopiHost();
    const unlock = jest.spyOn(wopiClient, 'unlock').mockResolvedValue(true);
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    const mask = {tenant, key: DOC_ID, status: row.status, statusInfo: row.status_info, additional: row.additional};
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementation(async (...args) => {
      const result = await withOwnership(...args);
      if (unlock.mock.calls.length > 0) {
        if (takeover === 'removed row') {
          row = null;
        } else {
          newerSaveTakesRow();
          row.callback = 'new session callback';
        }
      }
      return result;
    });

    await expect(docsCoServer.cleanDocumentOnExitPromise(ctx, DOC_ID, true, 1, undefined, mask)).resolves.toBe(false);

    expect(unlock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        commonInfo: expect.objectContaining({lockId: 'lock'}),
        userAuth: expect.objectContaining({access_token: 'token'})
      })
    );
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(canvasservice.commandOpenStartPromise).not.toHaveBeenCalled();
    expect(row?.callback ?? null).toBe(takeover === 'removed row' ? null : 'new session callback');
  });

  test('WOPI: ownership is held through UNLOCK and released before the conditional marker write', async () => {
    fakeWopiHost();
    let locked = false;
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementation((ctx, mask, action) =>
      withOwnership(ctx, mask, async lockedRow => {
        locked = true;
        try {
          await action(lockedRow);
        } finally {
          locked = false;
        }
      })
    );
    jest.spyOn(wopiClient, 'unlock').mockImplementation(async () => {
      expect(locked).toBe(true);
      return true;
    });
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (...args) => {
      expect(locked).toBe(false);
      return updateIf(...args);
    });

    await deliver(queued());

    expectCompleted();
    expect(taskResult.updateIf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callback: expect.stringContaining('"unlockId":"lock"')
      }),
      expect.objectContaining({statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO})
    );
    expect(sqlBase.UserCallback.prototype.getCallbacks(new operationContext.Context(), row.callback)).toContainEqual(
      expect.stringContaining('"unlockId":"lock"')
    );
    expect(canvasservice.commandOpenStartPromise).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(0);
  });

  test('WOPI: a second Unlock answered 409 after a later failure does not loop', async () => {
    const host = fakeWopiHost();
    // A step after the Unlock and before completion fails once.
    jest.spyOn(docsCoServer.editorData, 'clearSavedCallbackAccepted').mockRejectedValueOnce(new Error('editor data unavailable'));

    await deliver(queued());
    expect(host.unlocks).toBe(1);
    expect(delayed).toHaveLength(1);

    expect(await drainRetries()).toBe(1);
    expect(delayed).toHaveLength(0);
    expect(host.puts).toBe(1);
    expect(host.unlocks).toBe(2);
    expectCompleted();
  });

  test('WOPI: an expired lock and token store the forgotten file once and finish', async () => {
    const host = fakeWopiHost({tokenValid: false});

    await deliver(queued());
    await drainRetries();

    expect(delayed).toHaveLength(0);
    expect(host.puts).toBe(1);
    expect(host.unlocks).toBe(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(row).toBeNull();
  });

  test.each([
    ['an HTTP retry', 'http'],
    ['a WOPI save retried after an infrastructure error', 'wopi']
  ])('%s carries no WOPI access token in its retry message', async (_name, kind) => {
    const host = 'wopi' === kind ? fakeWopiHost() : undefined;
    if ('wopi' === kind) {
      docsCoServer.editorData.getForceSave.mockRejectedValueOnce(new Error('editor data unavailable'));
    } else {
      docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('integrator unavailable'), {statusCode: 503}));
    }
    // The converter's response still has the WOPI parameters it was given.
    const cmd = command();
    cmd.setWopiParams({userAuth: {wopiSrc: 'https://wopi.example.test/wopi/files/1', access_token: 'secret-token'}, commonInfo: {}});
    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant, docId: DOC_ID, userId: 'user'});
    task.setCmd(cmd);

    await deliver(JSON.stringify(task));
    expect(delayed).toHaveLength(1);
    expect(delayed[0].data).not.toContain('secret-token');
    expect(await drainRetries()).toBe(1);

    expectCompleted();
    if (host) {
      // The retry saves with the parameters of the task row.
      expect(host.puts).toBe(1);
    }
  });

  test('WOPI: a close without changes finishes when Unlock is rejected', async () => {
    const host = fakeWopiHost({tokenValid: false});
    row.status = Ok;
    row.status_info = constants.NO_ERROR;

    const {ack} = await deliver(queued({status_info: constants.EDITOR_CHANGES}));
    await drainRetries();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
    expect(host.unlocks).toBe(1);
  });

  test('an accepted retry that finds its row gone stops without cleaning anything', async () => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));

    await deliver(queued());
    expect(delayed).toHaveLength(1);
    // GC or a WOPI cache invalidation removed it; a new session may be starting.
    row = null;
    const editorDataCleanup = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');

    expect(await drainRetries()).toBe(1);
    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(editorDataCleanup).not.toHaveBeenCalled();
    expect(sqlBase.deleteChangesPromise).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
  });

  test('infrastructure retries do not use up the HTTP callback retry budget', async () => {
    const storageError = new Error('editor data unavailable');
    docsCoServer.editorData.getForceSave.mockRejectedValueOnce(storageError).mockRejectedValueOnce(storageError).mockRejectedValueOnce(storageError);
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));

    await deliver(queued());
    expect(await drainRetries()).toBe(4);

    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
    expect(storage.copyObject).not.toHaveBeenCalled();
    expectCompleted();
  });

  test('an exhausted dead letter runs real abandonment and releases saved state before acknowledgement', async () => {
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    operationContext.Context.prototype.getCfg.mockImplementation((path, fallback) =>
      path === 'services.CoAuthoring.callbackBackoffOptions' ? {...options, infraRetries: 1} : fallback
    );
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
    await deliver(queued());
    expect(delayed).toHaveLength(1);
    expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_STATUS_INFO);
    const clearAccepted = jest.spyOn(docsCoServer.editorData, 'clearSavedCallbackAccepted');
    const ack = jest.fn(() => {
      expect(row.status_info).toBeLessThan(commonDefines.FINAL_SAVE_PENDING_STATUS_INFO);
      expect(clearAccepted).toHaveBeenCalledTimes(1);
    });
    const nack = jest.fn();
    await docsCoServer.handleDeadLetter(delayed.shift().data, ack, nack, undefined, new Queue());
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion}));
    expect(errors.some(error => error.includes('giving up after 1 infrastructure retries'))).toBe(true);
  });

  test('a persistent failure gives up after the retry budget and leaves the row expirable', async () => {
    const budget = config.get('services.CoAuthoring.callbackBackoffOptions').infraRetries;
    expect(budget).toBeGreaterThan(0);
    taskResult.restoreInitialPassword.mockRejectedValue(new Error('SQL unavailable'));

    await deliver(queued());
    const deliveries = await drainRetries({limit: budget + 5});

    expect(deliveries).toBe(budget);
    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(errors.some(message => message.includes('giving up'))).toBe(true);
    // The cleanup never deleted the changes, so the session is left to resume
    // from the cache with them, whatever the integrator did with the file.
    expect(row.status).toBe(SaveVersion);
    expect(row.status_info).toBe(12);
    expect(changesLeft).toBe(true);
    expect(taskResult.deleteChangesIf).not.toHaveBeenCalled();
    // Editors that connected during the save are told it ended; the saved
    // state was read, so success is known.
    expect(docsCoServer.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion, success: true})
    );
  });

  test('a retry whose publication fails is retried in process with its state', async () => {
    useFastBackoff();
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    const broker = new Error('broker unavailable');
    docsCoServer.addDelayed
      .mockImplementationOnce(function* () {
        yield Promise.reject(broker);
      })
      .mockImplementationOnce(function* () {
        yield Promise.reject(broker);
      });

    const {ack} = await deliver(queued());

    expect(ack).toHaveBeenCalledTimes(1);
    expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(3);
    expect(delayed).toHaveLength(1);
    const retry = new commonDefines.TaskQueueData(JSON.parse(delayed[0].data)).getCmd();
    expect(retry.getAttempt()).toBe(3);
    expect(retry.getCallbackDeclined()).toBe(true);

    expect(await drainRetries()).toBe(1);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(row).toBeNull();
  });

  test('a late retry does not take over the row of a newer save (declined)', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    await deliver(queued());
    expect(delayed).toHaveLength(1);
    // Meanwhile the document was reopened, edited and closed again: the newer
    // save moved the row to UpdateVersion in a later minute.
    now += 120000;
    newerSaveTakesRow();
    const newerRow = {...row};

    expect(await drainRetries()).toBe(1);

    expect(delayed).toHaveLength(0);
    expect(row).toEqual(newerRow);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(taskResult.removeIf).not.toHaveBeenCalled();
  });

  test('a late retry does not take over the row of a newer save (accepted)', async () => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
    await deliver(queued());
    expect(delayed).toHaveLength(1);
    now += 120000;
    row.status = UpdateVersion;
    row.status_info = minute();
    row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('newer-session');
    const newerRow = {...row};

    expect(await drainRetries()).toBe(1);

    expect(delayed).toHaveLength(0);
    expect(row).toEqual(newerRow);
    expect(sqlBase.deleteChangesPromise).not.toHaveBeenCalled();
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test.each(['changes', 'password'])('an accepted save paused before %s cleanup cannot clean a newer accepted save', async stage => {
    const first = cleanupBarrier();
    const second = cleanupBarrier();
    let calls = 0;
    if (stage === 'changes') {
      const deleteChanges = taskResult.deleteChangesIf.getMockImplementation();
      taskResult.deleteChangesIf.mockImplementation(async (...args) => {
        await (++calls === 1 ? first : second).pause();
        return deleteChanges(...args);
      });
    } else {
      taskResult.restoreInitialPassword.mockImplementation(async (_ctx, _id, mask) => {
        await (++calls === 1 ? first : second).pause();
        if (rowMatches(mask)) {
          row.password = 'restored';
        }
      });
    }
    const saveA = deliver(queued());
    let saveB;
    try {
      await first.started;
      const ctx = new operationContext.Context();
      ctx.setTenant(tenant);
      now += 86400000;
      expect(canvasservice.isUpdateVersionExpired(ctx, row, 5 * 60000)).toBe(true);
      expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(Ok);
      row.status = SaveVersion;
      row.status_info = 12;
      row.password = 'new-session-password';
      saveB = deliver(queued({savekey: 'save-B'}));
      await second.started;
      const pendingB = {...row};
      expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-B', phase: 'accepted'}));
      first.release();
      await saveA;

      expect(row).toEqual(pendingB);
      expect(changesLeft).toBe(true);
      expect(storage.deletePath).not.toHaveBeenCalled();
      expect(taskResult.removeIf).not.toHaveBeenCalled();
    } finally {
      first.release();
      second.release();
      await Promise.all([saveA, saveB]);
    }
    expectCompleted('save-B');
    expect(await drainRetries()).toBe(1);
    expectCompleted('save-B');
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
  });

  test.each([false, true])('a stale accepted completion preserves the next save (from forgotten: %s)', async fromForgotten => {
    if (fromForgotten) {
      storage.listObjects.mockImplementation(async (_ctx, path) =>
        path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']
      );
    }
    const first = cleanupBarrier();
    const second = cleanupBarrier();
    const clean = docsCoServer.cleanDocumentOnExitPromise;
    jest.spyOn(docsCoServer, 'cleanDocumentOnExitPromise').mockImplementation(async (...args) => {
      if (finalSaveMarkers().at(-1)?.operationId === 'save-B') {
        await second.pause();
        return clean(...args);
      }
      const result = await clean(...args);
      await first.pause();
      return result;
    });
    const saveA = deliver(queued());
    let saveB;
    try {
      await first.started;
      now += 86400000;
      const ctx = new operationContext.Context();
      ctx.setTenant(tenant);
      expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(commonDefines.FileStatus.None);
      row.status = SaveVersion;
      row.status_info = 12;
      changesLeft = true;
      saveB = deliver(queued({savekey: 'save-B'}));
      await second.started;
      const pendingB = {...row};
      storage.deletePath.mockClear();
      first.release();
      await saveA;

      expect(row).toEqual(pendingB);
      expect(changesLeft).toBe(true);
      expect(storage.deletePath).not.toHaveBeenCalled();
      expect(taskResult.removeIf).not.toHaveBeenCalled();
    } finally {
      first.release();
      second.release();
      await Promise.all([saveA, saveB]);
    }
  });

  test('a stale delivery of an earlier save does not resend after a later save appended its marker', async () => {
    const original = queued();
    await deliver(original);
    expectCompleted('save-key');
    // The document is reopened and closed again: a later save completes and
    // appends its own markers.
    now += 120000;
    row.status = SaveVersion;
    row.status_info = 12;
    await deliver(queued({savekey: 'later-save'}));
    expectCompleted('later-save');
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
    const rowAfterLaterSave = {...row};

    const {ack} = await deliver(original);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
    expect(row).toEqual(rowAfterLaterSave);
  });

  test('a pending status expires a fixed window after its save began it, whatever opens do', async () => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
    await deliver(queued());
    expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_STATUS_INFO);
    const ctx = new operationContext.Context();
    const expire = 5 * 60000;
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    let window = 0;
    for (let i = 0; i < options.infraRetries; ++i) {
      window += require('../../DocService/node_modules/retry').createTimeout(Math.min(i, 3), options.timeout);
    }
    // A live save keeps the row through its whole retry window.
    now += expire + 1000;
    expect(canvasservice.isUpdateVersionExpired(ctx, row, expire)).toBe(false);
    // Opens refresh last_open_date; that must not keep an abandoned save alive.
    now += window;
    row.last_open_date = new Date(now);
    expect(canvasservice.isUpdateVersionExpired(ctx, row, expire)).toBe(true);
  });

  test('a declined retry resumes its claimed forgotten cleanup instead of restoring the row', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    // The cleanup claims the row and drops the changes, then storage fails.
    storage.deletePath.mockRejectedValueOnce(new Error('cache storage unavailable'));
    await deliver(queued());
    expect(row.status).toBe(UpdateVersion);
    expect(row.status_info).toBeGreaterThan(commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO);
    expect(taskResult.deleteChangesIf).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    // Storage stays unavailable for the forgotten copy too.
    storage.copyObject.mockRejectedValue(new Error('forgotten storage unavailable'));

    expect(await drainRetries()).toBe(1);

    // Not restored to SaveVersion (its changes are gone), no second copy.
    expect(row).toBeNull();
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
  });

  test('a redelivered declined save does not send its callback again', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    const original = queued();
    await deliver(original);
    expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-key', phase: 'declined'}));

    // The broker redelivers the original (no retry state in it).
    await deliver(original);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(2);
    expect(row).toBeNull();
  });

  test('a retry that never wrote the row does not take over a newer save', async () => {
    docsCoServer.getEditorsCountPromise.mockRejectedValueOnce(new Error('editor data unavailable'));
    await deliver(queued());
    expect(row.status).toBe(SaveVersion);
    expect(delayed).toHaveLength(1);
    now += 120000;
    row.status = UpdateVersion;
    row.status_info = minute();
    const newerRow = {...row};

    expect(await drainRetries()).toBe(1);

    expect(row).toEqual(newerRow);
    expect(docsCoServer.sendServerRequest).not.toHaveBeenCalled();
  });

  test('a late retry leaves a reopened document alone', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    await deliver(queued());
    // Reopened: the open path moved the row on and a conversion is running.
    row.status = commonDefines.FileStatus.WaitQueue;
    row.status_info = minute();
    docsCoServer.getEditorsCountPromise.mockResolvedValue(1);
    const reopenedRow = {...row};
    const updates = taskResult.updateIf.mock.calls.length;

    expect(await drainRetries()).toBe(1);

    expect(row).toEqual(reopenedRow);
    expect(taskResult.updateIf.mock.calls.length).toBe(updates);
    expect(delayed).toHaveLength(0);
  });

  test.each(['channel close', 'connection loss'])('a failed retry confirmation stops after a real %s event', async closure => {
    jest.useFakeTimers({doNotFake: ['Date']});
    const broker = rabbit(rabbitCore);
    const queue = new Queue();
    try {
      await queue.initPromise(false, false, false, true, false, true);
      const source = queue.channelConvertResponseReceive;
      const sender = queue.channelDelayed;
      let confirm;
      sender.sendToQueue.mockImplementation((_name, _body, _options, callback) => {
        confirm = callback;
      });
      docsCoServer.addDelayed.mockRestore();
      const addDelayed = docsCoServer.addDelayed;
      jest.spyOn(docsCoServer, 'addDelayed').mockImplementation(function* (task, ttl, _queue, requireConfirm) {
        yield* addDelayed(task, ttl, queue, requireConfirm);
      });
      taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
      let processing;
      let live;
      queue.on('response', (data, ack, isLive) => {
        live = isLive;
        processing = canvasservice.receiveTask(data, ack, isLive);
      });
      broker.deliver(source, queued());
      await jest.advanceTimersByTimeAsync(0);
      expect(live()).toBe(true);
      expect(sender.sendToQueue).toHaveBeenCalledTimes(1);
      expect(source.ack).not.toHaveBeenCalled();
      const retry = JSON.parse(sender.sendToQueue.mock.calls[0][1]);
      expect(retry.cmd).toMatchObject({attempt: 1, callbackAccepted: true});
      confirm(new Error('broker confirmation failed'));
      await jest.advanceTimersByTimeAsync(0);
      if (closure === 'channel close') {
        source.emit('close');
        expect(queue.connection).not.toBeNull();
      } else {
        queue.isClose = true;
        broker.disconnect();
      }
      expect(live()).toBe(false);
      await jest.advanceTimersByTimeAsync(8000);
      await processing;
      expect(sender.sendToQueue).toHaveBeenCalledTimes(1);
      expect(docsCoServer.addDelayed).toHaveBeenCalledTimes(1);
      expect(source.ack).not.toHaveBeenCalled();
      expect(source.nack).not.toHaveBeenCalled();
      expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
      expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_STATUS_INFO);
    } finally {
      queue.removeAllListeners();
      broker.channels.forEach(source => source.removeAllListeners());
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('a database without the additional column still saves', async () => {
    delete row.additional;
    const {ack} = await deliver(queued());

    expect(ack).toHaveBeenCalledTimes(1);
    expect(row.status_info).toBe(minute());
    for (const [, update] of taskResult.updateIf.mock.calls) {
      expect(update.additional ?? null).toBeNull();
    }
  });

  test('the infrastructure retry delay does not depend on the HTTP retry count', async () => {
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    operationContext.Context.prototype.getCfg.mockImplementation((path, fallback) =>
      path === 'services.CoAuthoring.callbackBackoffOptions' ? {...options, retries: 0} : fallback
    );
    taskResult.restoreInitialPassword.mockRejectedValue(new Error('SQL unavailable'));
    await deliver(queued({attempt: 10}));

    const retry = require('../../DocService/node_modules/retry');
    expect(delayed[0].ttl).toBe(retry.createTimeout(3, options.timeout));
  });

  test('a given-up save opened from the forgotten file resumes from the cache while its changes remain', async () => {
    const forgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
    storage.listObjects.mockImplementation(async (_ctx, path) => (path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']));
    taskResult.restoreInitialPassword.mockRejectedValue(new Error('SQL unavailable'));

    await deliver(queued());
    expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO);
    await drainRetries({limit: 100});

    // Resumed, not reopened from the old forgotten file.
    expect(row.status).toBe(SaveVersion);
    expect(changesLeft).toBe(true);
    expect(storage.deletePath).not.toHaveBeenCalledWith(expect.anything(), DOC_ID, forgottenFiles);
  });

  test('a given-up save whose changes are gone reloads, and drops the forgotten file it replaced', async () => {
    const forgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
    const budget = config.get('services.CoAuthoring.callbackBackoffOptions').infraRetries;
    storage.listObjects.mockImplementation(async (_ctx, path) => (path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']));
    // The cleanup deletes the changes, then keeps failing on the forgotten file.
    let forgottenDeletes = 0;
    storage.deletePath.mockImplementation(async (_ctx, _docId, prefix) => {
      if (prefix === forgottenFiles && ++forgottenDeletes <= budget + 1) {
        throw new Error('forgotten storage unavailable');
      }
    });

    await deliver(queued());
    await drainRetries({limit: 100});

    expect(changesLeft).toBe(false);
    expect(forgottenDeletes).toBe(budget + 2);
    // A reopen loads the integrator's file, not the stale forgotten file.
    expect(row.status).toBe(UpdateVersion);
    expect(row.status_info).toBeLessThan(commonDefines.FINAL_SAVE_PENDING_STATUS_INFO);
  });

  test('an accepted save reported unsaved keeps its changes until the forgotten file is stored', async () => {
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    storage.copyObject.mockRejectedValue(new Error('forgotten storage unavailable'));

    await deliver(queued());
    await drainRetries({limit: 100});

    expect(delayed).toHaveLength(0);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    // Given up without a forgotten file: the changes stay and a reopen resumes them.
    expect(taskResult.deleteChangesIf).not.toHaveBeenCalled();
    expect(row.status).toBe(SaveVersion);
    expect(row.status_info).toBe(12);
    expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-key', phase: 'declined'}));
  });

  test('a late retry does not run the forgotten-file path on a new session without a callback', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    await deliver(queued());
    // A new session took the row; it has no callback yet.
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    row.callback = null;
    const newSession = {...row};

    expect(await drainRetries()).toBe(1);

    expect(row).toEqual(newSession);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(taskResult.claimIf).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
  });

  test('without the additional column a declined save still resumes its cleanup claim', async () => {
    delete row.additional;
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.deletePath.mockRejectedValueOnce(new Error('cache storage unavailable'));
    await deliver(queued());
    expect(row.status_info).toBeGreaterThan(commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO);

    expect(await drainRetries()).toBe(1);

    expect(row).toBeNull();
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
  });

  test('no retry is scheduled from a delivery the broker has requeued', async () => {
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));
    await canvasservice.receiveTask(queued(), jest.fn(), () => false);
    expect(docsCoServer.addDelayed).not.toHaveBeenCalled();
    expect(row.status).toBe(SaveVersion);
  });

  test('a forcesave does not track or release final-save state', async () => {
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    const getAccepted = jest.spyOn(docsCoServer.editorData, 'getSavedCallbackAccepted');
    const clearAccepted = jest.spyOn(docsCoServer.editorData, 'clearSavedCallbackAccepted');
    const warnings = [];
    LoggerPrototype.warn.mockImplementation((...args) => warnings.push(util.format(...args)));

    await deliver(queued({c: 'sfcm'}));

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(getAccepted).not.toHaveBeenCalled();
    expect(clearAccepted).not.toHaveBeenCalled();
    expect(warnings.some(message => message.includes('not this save'))).toBe(false);
  });

  test('giving up does not publish updateVersion to a new session', async () => {
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    // A new session is active, so the backend defers the cleanup every time.
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(false);
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockResolvedValue([]);
    jest.spyOn(utils, 'postRequestPromise').mockResolvedValue({response: {headers: {}}, body: '{"error":0}'});

    await deliver(queued({status_info: constants.EDITOR_CHANGES}));
    await drainRetries({limit: 100});

    expect(errors.some(message => message.includes('giving up'))).toBe(true);
    expect(docsCoServer.publish).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion})
    );
  });

  test('old final-save markers are pruned once a reused key collects too many', async () => {
    for (let i = 0; i < 20; ++i) {
      const data = new sqlBase.DocumentAdditional();
      data.data.push({[MARKER]: {operationId: `old-${i}`, phase: 'accepted', openFromForgotten: false, since: now - 86400000}});
      row.additional += data.toSQLInsert();
    }

    await deliver(queued());

    expectCompleted();
    // The rewrite at the save's first write keeps 9 old markers plus its own;
    // its accepted marker is then appended.
    const markers = finalSaveMarkers();
    expect(markers).toHaveLength(11);
    expect(markers.slice(-2).map(marker => marker.operationId)).toEqual(['save-key', 'save-key']);
    expect(markers[0]).toEqual(expect.objectContaining({operationId: 'old-11'}));
    // Other entries are kept.
    expect(additionalEntries().filter(item => item.shardKey)).toHaveLength(1);
  });

  test('a redelivery that took over its own row still completes after a failed acceptance write', async () => {
    // A crash after the UpdateVersion write: the original is redelivered.
    row.status = UpdateVersion;
    row.status_info = minute();
    const updateIf = taskResult.updateIf.getMockImplementation();
    let failed = false;
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      if (!failed && task.statusInfo === commonDefines.CALLBACK_ACCEPTED_STATUS_INFO) {
        failed = true;
        throw new Error('SQL unavailable');
      }
      return updateIf(ctx, task, mask, updateTime);
    });

    await deliver(queued());
    expect(delayed).toHaveLength(1);
    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expectCompleted();
    expect(changesLeft).toBe(false);
  });

  test("a first delivery does not take over another save's pending status", async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
    const data = new sqlBase.DocumentAdditional();
    data.data.push({[MARKER]: {operationId: 'newer-save', phase: 'accepted', openFromForgotten: false, since: now}});
    row.additional += data.toSQLInsert();
    const pending = {...row};

    await deliver(queued());

    expect(docsCoServer.sendServerRequest).not.toHaveBeenCalled();
    expect(row).toEqual(pending);
  });

  test('an encrypted save accepted but reported unsaved gets its previous status back', async () => {
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    docsCoServer.getEditorsCountPromise.mockResolvedValue(1);
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);

    await canvasservice.commandSfcCallback(ctx, command(), false, true);

    expect(row.status).toBe(Ok);
    expect(row.status_info).toBe(constants.NO_ERROR);
  });

  test('without the additional column no pending acceptance status is written', async () => {
    delete row.additional;
    await deliver(queued());
    const statuses = taskResult.updateIf.mock.calls.map(([, task]) => task.statusInfo);
    expect(statuses).not.toContain(commonDefines.CALLBACK_ACCEPTED_STATUS_INFO);
    expect(row.status_info).toBe(minute());
  });

  test('HTTP callback retries back off by their own count', async () => {
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    operationContext.Context.prototype.getCfg.mockImplementation((path, fallback) =>
      path === 'services.CoAuthoring.callbackBackoffOptions' ? {...options, retries: 10} : fallback
    );
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));

    const task = new commonDefines.TaskQueueData();
    task.setCtx({tenant, docId: DOC_ID, userId: 'user'});
    const cmd = command({attempt: 8});
    cmd.setCallbackAttempt(5);
    task.setCmd(cmd);
    await deliver(JSON.stringify(task));

    const retry = require('../../DocService/node_modules/retry');
    expect(delayed[0].ttl).toBe(retry.createTimeout(5, options.timeout));
  });

  test('a pruning rewrite keeps entries appended during the callback', async () => {
    for (let i = 0; i < 20; ++i) {
      const data = new sqlBase.DocumentAdditional();
      data.data.push({[MARKER]: {operationId: `old-${i}`, phase: 'accepted', openFromForgotten: false, since: now - 86400000}});
      row.additional += data.toSQLInsert();
    }
    docsCoServer.sendServerRequest.mockImplementation(async () => {
      // Another writer appends while the callback is in flight.
      row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('appended-meanwhile');
      return '{"error":0}';
    });

    await deliver(queued());

    expect(additionalEntries().filter(item => item.shardKey === 'appended-meanwhile')).toHaveLength(1);
    expect(finalSaveMarkers()).toHaveLength(11);
  });

  test('metadata appended during a declined restore retries the same operation', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    const updateIf = taskResult.updateIf.getMockImplementation();
    let appended = false;
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      if (!appended && task.status === SaveVersion) {
        appended = true;
        row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('appended-meanwhile');
      }
      return updateIf(ctx, task, mask, updateTime);
    });

    await deliver(queued());
    expect(delayed).toHaveLength(1);
    expect(await drainRetries()).toBe(1);

    expect(row).toBeNull();
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
  });

  test('a session opened from the forgotten file ends with cache and row removed at completion', async () => {
    storage.listObjects.mockImplementation(async (_ctx, path) => (path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']));
    const cacheDeleted = [];
    storage.deletePath.mockImplementation(async (_ctx, docId, prefix) => {
      if (undefined === prefix) {
        // The cache goes while the row still keeps opens (and viewers) out.
        cacheDeleted.push({...row});
      }
    });

    await deliver(queued());

    expect(delayed).toHaveLength(0);
    expect(cacheDeleted).toEqual([
      expect.objectContaining({status: UpdateVersion, status_info: commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO})
    ]);
    expect(row).toBeNull();
  });

  test('an open taking over an abandoned save holds the row while it decides: a slow attempt cannot delete the changes', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    const acceptedMask = {tenant, key: DOC_ID, status: UpdateVersion, statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO};
    const masks = [];
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      masks.push({...mask});
      return updateIf(ctx, task, mask, updateTime);
    });
    // The abandoned save's slow attempt deletes its changes while the open
    // checks them.
    let slowDelete;
    sqlBase.getChangesIndexPromise.mockImplementationOnce(async () => {
      slowDelete = await taskResult.deleteChangesIf(ctx, acceptedMask);
      return [{change_id: changesLeft ? 3 : null}];
    });

    const status = await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row});

    expect(slowDelete).toEqual({affectedRows: 0});
    expect(changesLeft).toBe(true);
    expect(status).toBe(Ok);
    expect(row.status).toBe(Ok);
    expect(storage.deletePath).not.toHaveBeenCalled();
    // Never conditional on Ok: a live session's row is not switched under it.
    expect(masks.filter(mask => Ok === mask.status)).toEqual([]);
  });

  test.each([
    ['remaining changes', true],
    ['remaining changes', false],
    ['claim', false],
    ['storage', false],
    ['release', false]
  ])('takeover retries metadata conflicts during %s (changes remain: %s)', async (stage, remaining) => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('pause accepted cleanup'));
    await deliver(queued());
    now += 86400000;
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    changesLeft = remaining;
    let appended = false;
    const append = () => {
      appended = true;
      row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('appended-meanwhile');
    };
    sqlBase.getChangesIndexPromise.mockImplementationOnce(async () => {
      if (stage === 'remaining changes') append();
      return [{change_id: remaining ? 3 : null}];
    });
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (...args) => {
      const claiming = args[1].statusInfo === commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO;
      if (!appended && ((stage === 'claim' && claiming) || (stage === 'release' && !claiming))) append();
      return updateIf(...args);
    });
    const cleanup = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementation(async (...args) => {
      if (!appended && stage === 'storage') append();
      return cleanup(...args);
    });

    const expected = remaining ? Ok : commonDefines.FileStatus.None;
    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(expected);
    expect(row.status).toBe(expected);
    expect(additionalEntries()).toContainEqual({shardKey: 'appended-meanwhile'});
    expect(storage.deletePath).toHaveBeenCalledTimes(remaining ? 0 : 1);
  });

  test('takeover does not refresh its snapshot across another operation with the same hold status', async () => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('pause accepted cleanup'));
    await deliver(queued());
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    let pendingB;
    sqlBase.getChangesIndexPromise.mockImplementationOnce(async () => {
      newerSaveTakesRow();
      row.status_info = commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO;
      pendingB = {...row};
      return [{change_id: 3}];
    });

    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBeUndefined();
    expect(row).toEqual(pendingB);
    expect(storage.deletePath).not.toHaveBeenCalled();
  });

  test.each(['cleanup claim', 'sending', 'restored'])('abandoning A leaves B cleanup state alone (%s)', async phase => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('pause A cleanup'));
    await deliver(queued());
    const retryA = new commonDefines.TaskQueueData(JSON.parse(delayed[0].data)).getCmd();
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    if (phase === 'cleanup claim') {
      delayed = [];
      now += 86400000;
      expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(Ok);
      row.status = SaveVersion;
      row.status_info = 12;
      docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
      storage.deletePath.mockRejectedValueOnce(new Error('pause B cache cleanup'));
      await deliver(queued({savekey: 'save-B'}));
      expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-B', phase: 'declined'}));
      expect(row.status_info).toBeGreaterThan(commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO);
    } else {
      newerSaveTakesRow();
      if (phase === 'restored') {
        row.status = SaveVersion;
        row.status_info = 12;
      }
    }
    const pendingB = {...row};
    docsCoServer.publish.mockClear();

    await canvasservice.abandonSfcRetry(ctx, retryA);

    expect(row).toEqual(pendingB);
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    if (phase !== 'cleanup claim') expect(storage.deletePath).not.toHaveBeenCalled();
  });

  test('takeover bounds retries when metadata is continuously appended', async () => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('pause accepted cleanup'));
    await deliver(queued());
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    const updateIf = taskResult.updateIf.getMockImplementation();
    let attempts = 0;
    taskResult.updateIf.mockImplementation(async (...args) => {
      attempts++;
      row.additional += sqlBase.DocumentAdditional.prototype.setShardKey(`writer-${attempts}`);
      return updateIf(...args);
    });

    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBeUndefined();
    expect(attempts).toBe(3);
    expect(row.status_info).toBe(commonDefines.CALLBACK_ACCEPTED_STATUS_INFO);
    expect(changesLeft).toBe(true);
    expect(storage.deletePath).not.toHaveBeenCalled();
  });

  test('a takeover of an interrupted hold decides like the takeover it replaces', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO;
    const data = new sqlBase.DocumentAdditional();
    data.data.push({[MARKER]: {operationId: 'save-key', phase: 'accepted', openFromForgotten: false, since: now}});
    row.additional += data.toSQLInsert();
    changesLeft = false;
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);

    expect(canvasservice.isUpdateVersionExpired(ctx, row, 5 * 60000)).toBe(true);
    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(commonDefines.FileStatus.None);
    expect(row.status).toBe(commonDefines.FileStatus.None);
    // The accepted save's forgotten file is obsolete.
    expect(storage.deletePath).toHaveBeenCalledWith(expect.anything(), DOC_ID, config.get('services.CoAuthoring.server.forgottenfiles'));
  });

  test('an interrupted hold is taken over where the database counts changed rows, not matched ones (MySQL, MariaDB)', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO;
    const data = new sqlBase.DocumentAdditional();
    data.data.push({[MARKER]: {operationId: 'save-key', phase: 'accepted', openFromForgotten: false, since: now}});
    row.additional += data.toSQLInsert();
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    // The open's upsert set last_open_date this second: a write of the values
    // the row already has changes nothing and reports 0 rows.
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      const unchanged =
        rowMatches(mask) &&
        !task.additional &&
        (task.status ?? row.status) === row.status &&
        (task.statusInfo ?? row.status_info) === row.status_info;
      const res = await updateIf(ctx, task, mask, updateTime);
      return unchanged ? {affectedRows: 0} : res;
    });
    const stale = {...row};

    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(Ok);
    expect(row.status).toBe(Ok);
    // A hold that another open finished meanwhile is left alone.
    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, stale)).toBeUndefined();
    expect(row.status).toBe(Ok);
    expect(storage.deletePath).not.toHaveBeenCalled();
  });

  test('a retried restore that changes nothing is not a lost row where the database counts changed rows (MySQL, MariaDB)', async () => {
    row.callback = null;
    // An open refreshed last_open_date this second: a write of the values the
    // row already has changes nothing and reports 0 rows.
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      const unchanged =
        rowMatches(mask) &&
        !task.additional &&
        (task.status ?? row.status) === row.status &&
        (task.statusInfo ?? row.status_info) === row.status_info;
      const res = await updateIf(ctx, task, mask, updateTime);
      return unchanged ? {affectedRows: 0} : res;
    });
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));

    await deliver(queued());
    expect(row.status).toBe(SaveVersion);
    expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-key', phase: 'declined'}));
    // The retry restores SaveVersion again, without a second marker.
    expect(await drainRetries()).toBe(1);

    expect(storage.copyObject).toHaveBeenCalledTimes(2);
    expect(row).toBeNull();
  });

  test('an interrupted hold expires at once, even right after a decline', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO;
    const data = new sqlBase.DocumentAdditional();
    data.data.push({[MARKER]: {operationId: 'save-key', phase: 'declined', openFromForgotten: false, since: now}});
    row.additional += data.toSQLInsert();

    expect(canvasservice.isUpdateVersionExpired(new operationContext.Context(), row, 5 * 60000)).toBe(true);
  });

  test('a takeover that another open finishes first reports undefined', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    sqlBase.getChangesIndexPromise.mockImplementationOnce(async () => {
      // Another open takes the hold over and resumes the session.
      row.status = Ok;
      row.status_info = constants.NO_ERROR;
      return [{change_id: 3}];
    });

    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBeUndefined();
    expect(row.status).toBe(Ok);
  });

  test('an open resumes an abandoned save from the cache while its changes remain', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);

    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, {...row})).toBe(Ok);
    expect(row.status).toBe(Ok);
    expect(storage.deletePath).not.toHaveBeenCalled();
  });

  test('a forgotten-file save without a callback dates its cleanup claim with its own marker', async () => {
    row.callback = null;
    storage.deletePath.mockRejectedValueOnce(new Error('cache storage unavailable'));

    await deliver(queued());

    expect(row.status_info).toBeGreaterThan(commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO);
    expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-key', phase: 'declined'}));
    expect(canvasservice.isUpdateVersionExpired(new operationContext.Context(), row, 5 * 60000)).toBe(false);
  });

  test('a pending status without a dated marker expires at once', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 12345;
    row.additional = null;
    row.last_open_date = new Date(now);
    expect(canvasservice.isUpdateVersionExpired(new operationContext.Context(), row, 5 * 60000)).toBe(true);
  });

  test('pending statuses fit status_info and read as a future minute to versions that do not know them', async () => {
    for (const value of [
      commonDefines.CALLBACK_ACCEPTED_STATUS_INFO,
      commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO,
      commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 3 + 99999999
    ]) {
      expect(value).toBeLessThanOrEqual(2147483647);
      // the expiry check of servers without pending statuses: Date.now() - status_info * 60000 > expire
      expect(Date.now() - value * 60000 > 5 * 60000).toBe(false);
    }
  });

  test('a retry recognizes its row even when the UpdateVersion write failed after it applied', async () => {
    const updateIf = taskResult.updateIf.getMockImplementation();
    let lost = false;
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      const res = await updateIf(ctx, task, mask, updateTime);
      if (!lost && task.status === UpdateVersion && mask.status === SaveVersion) {
        // Applied, but the reply is lost.
        lost = true;
        throw new Error('connection reset');
      }
      return res;
    });

    await deliver(queued());
    expect(row.status).toBe(UpdateVersion);
    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expectCompleted();
  });

  test('a takeover for an open reports None (0) for a reload and undefined only when the row changed', async () => {
    row.status = UpdateVersion;
    row.status_info = commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
    changesLeft = false;
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    const pendingRow = {...row};
    // The auth path must treat None (0) as success, not as falsy.
    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, pendingRow)).toBe(commonDefines.FileStatus.None);
    expect(await canvasservice.takeOverAbandonedSaveForOpen(ctx, DOC_ID, pendingRow)).toBeUndefined();
  });

  test('a redelivery after a crash between the completion and the updateVersion event publishes the event', async () => {
    // The worker dies right before the event: its retry never goes out, and
    // the broker redelivers the original message (no retry state).
    docsCoServer.publish.mockRejectedValueOnce(new Error('worker crashed'));
    await deliver(queued());
    expectCompleted();
    delayed = [];

    await deliver(queued());

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expect(docsCoServer.publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion, docId: DOC_ID, success: true})
    );
    expect(delayed).toHaveLength(0);
  });

  test('a redelivered retry of a session opened from the forgotten file publishes the event its completion owed', async () => {
    storage.listObjects.mockImplementation(async (_ctx, path) => (path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']));
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
    await deliver(queued());
    expect(delayed).toHaveLength(1);
    const retry = delayed.shift();
    // The retry completes (its row goes) and the worker dies before the event.
    docsCoServer.publish.mockRejectedValueOnce(new Error('worker crashed'));
    await deliver(retry.data);
    expect(row).toBeNull();
    delayed = [];

    await deliver(retry.data);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expect(docsCoServer.publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion, docId: DOC_ID, success: true})
    );
    expect(delayed).toHaveLength(0);
  });

  test('a redelivery after an open took the completed row over publishes nothing', async () => {
    await deliver(queued());
    expectCompleted();
    // Expired and taken over by an open.
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    docsCoServer.publish.mockClear();

    await deliver(queued());

    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(row.status).toBe(Ok);
  });

  test('a failed shutdown-entry release after the event does not publish it again', async () => {
    docsCoServer.getIsShutdown.mockReturnValue(true);
    jest.spyOn(docsCoServer.editorStat, 'removeShutdown').mockRejectedValue(new Error('redis unavailable'));

    const {ack} = await deliver(queued());

    expect(ack).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(1);
    expectCompleted();
  });

  test('an accepted save keeps the signed download URL out of its retry messages', async () => {
    // Accepted, then the acceptance cannot be persisted: a retry goes out.
    const updateIf = taskResult.updateIf.getMockImplementation();
    let failed = false;
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      if (!failed && task.statusInfo === commonDefines.CALLBACK_ACCEPTED_STATUS_INFO) {
        failed = true;
        throw new Error('SQL unavailable');
      }
      return updateIf(ctx, task, mask, updateTime);
    });

    await deliver(queued());

    expect(delayed).toHaveLength(1);
    expect(delayed[0].data).toContain('"callbackAccepted":true');
    expect(delayed[0].data).not.toContain('https://storage.example.test/signed');
    expect(await drainRetries()).toBe(1);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expectCompleted();
  });

  test("the cleanup restores the password only while the row is still the save's", async () => {
    await deliver(queued());

    expect(taskResult.restoreInitialPassword).toHaveBeenCalledWith(
      expect.anything(),
      DOC_ID,
      expect.objectContaining({status: UpdateVersion, statusInfo: commonDefines.CALLBACK_ACCEPTED_STATUS_INFO})
    );
  });

  test('the error path publishes no retry from a delivery the broker has taken back', async () => {
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
    const ack = jest.fn();
    await canvasservice.receiveTask(queued(), ack, () => false);
    expect(docsCoServer.addDelayed).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  test("a restored save does not take a newer save's row written in the same minute", async () => {
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));
    await deliver(queued());
    expect(row.status).toBe(SaveVersion);
    // Reopened, edited and closed: the newer save writes UpdateVersion in the
    // same wall-clock minute.
    newerSaveTakesRow();
    const newerRow = {...row};
    const {data} = delayed.shift();

    await deliver(data);

    expect(row).toEqual(newerRow);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test('a retried close without changes leaves a reopened document alone', async () => {
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockResolvedValue([]);
    jest.spyOn(utils, 'postRequestPromise').mockResolvedValue({response: {headers: {}}, body: '{"error":0}'});
    const cleanup = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockRejectedValueOnce(new Error('editor data unavailable'));
    await deliver(queued({status_info: constants.EDITOR_CHANGES}));
    expect(delayed).toHaveLength(1);
    docsCoServer.getEditorsCountPromise.mockResolvedValue(1);

    expect(await drainRetries()).toBe(1);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
  });

  test('an accepted save whose row was taken over before its cleanup cleans nothing', async () => {
    const editorDataCleanup = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');
    // An open takes the row over between the acceptance and the cleanup.
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockImplementation(async () => {
      row.status = Ok;
      row.status_info = constants.NO_ERROR;
      return null;
    });

    await deliver(queued());
    await drainRetries();

    expect(editorDataCleanup).not.toHaveBeenCalled();
    expect(changesLeft).toBe(true);
    expect(row.status).toBe(Ok);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test('giving up releases the minute row of an acceptance that could not be persisted', async () => {
    const updateIf = taskResult.updateIf.getMockImplementation();
    taskResult.updateIf.mockImplementation(async (ctx, task, mask, updateTime) => {
      if (task.statusInfo === commonDefines.CALLBACK_ACCEPTED_STATUS_INFO) {
        throw new Error('SQL unavailable');
      }
      return updateIf(ctx, task, mask, updateTime);
    });

    await deliver(queued());
    await drainRetries({limit: 100});

    expect(errors.some(message => message.includes('giving up'))).toBe(true);
    // Its changes are still there: resumable, not replayed over the integrator's file.
    expect(row.status).toBe(SaveVersion);
    expect(row.status_info).toBe(12);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test('a late delivery does not treat a WOPI invalidation claim as its own', async () => {
    const original = queued();
    await deliver(original);
    expectCompleted();
    // A WOPI cache invalidation claimed the row afterwards; this save's marker
    // is still the last one.
    row.status_info = commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 3 + 12345;
    const claimed = {...row};
    const editorDataCleanup = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');

    await deliver(original);

    expect(row).toEqual(claimed);
    expect(editorDataCleanup).not.toHaveBeenCalled();
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test('every open computes the same expiry with randomized backoff', async () => {
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    operationContext.Context.prototype.getCfg.mockImplementation((path, fallback) =>
      path === 'services.CoAuthoring.callbackBackoffOptions' ? {...options, timeout: {...options.timeout, randomize: true}} : fallback
    );
    taskResult.restoreInitialPassword.mockRejectedValueOnce(new Error('SQL unavailable'));
    await deliver(queued());
    const ctx = new operationContext.Context();
    // Past the nominal window, within the randomized upper bound.
    now += 5 * 60000 + 1.5 * 463000;
    const results = new Set();
    for (let i = 0; i < 20; ++i) {
      results.add(canvasservice.isUpdateVersionExpired(ctx, row, 5 * 60000));
    }
    expect([...results]).toEqual([false]);
  });

  test('a redelivered retry recognizes the row it wrote after an earlier restore', async () => {
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));
    await deliver(queued());
    expect(row.status).toBe(SaveVersion);
    const {data} = delayed.shift();
    // The retry takes the row (and names itself on it), then its worker dies:
    // the broker redelivers the retry as it was published.
    now += 61000;
    let died = false;
    docsCoServer.editorData.getForceSave.mockImplementationOnce(async () => {
      died = true;
      throw new Error('worker died');
    });
    docsCoServer.addDelayed.mockImplementationOnce(function* () {
      yield new Promise(() => {});
    });
    void deliver(data);
    await new Promise(setImmediate);
    expect(died).toBe(true);
    expect(row.status).toBe(UpdateVersion);

    await deliver(data);

    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(2);
    expectCompleted();
  });

  test.each([
    ['retry', 'declined'],
    ['redelivery', 'declined'],
    ['retry', 'sending'],
    ['redelivery', 'sending']
  ])('an old %s cannot claim B restored SaveVersion after its %s phase', async (delivery, phase) => {
    jest.spyOn(docsCoServer.editorData, 'getdelSaved').mockResolvedValue('0');
    storage.copyObject.mockRejectedValueOnce(new Error('pause A recovery copy'));
    const originalA = queued();
    await deliver(originalA);
    const retryA = delayed.shift().data;
    expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-key', phase: 'declined'}));
    // SaveVersion input values are milliseconds within the hour and can recur.
    now += 3600000;
    row.status = SaveVersion;
    row.status_info = 12;
    row.password = 'B-password';
    if (phase === 'declined') {
      storage.copyObject.mockRejectedValueOnce(new Error('pause B recovery copy'));
    } else {
      docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('pause B callback'), {statusCode: 503}));
    }
    await deliver(queued({savekey: 'save-B'}));
    expect(row.status).toBe(SaveVersion);
    expect(finalSaveMarkers().at(-1)).toEqual(expect.objectContaining({operationId: 'save-B', phase}));
    const pendingB = {...row};
    const retryB = [...delayed];
    for (const mock of [
      storage.copyObject,
      storage.deletePath,
      taskResult.updateIf,
      taskResult.deleteChangesIf,
      taskResult.removeIf,
      docsCoServer.publish
    ]) {
      mock.mockClear();
    }

    const {ack} = await deliver(delivery === 'retry' ? retryA : originalA);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(row).toEqual(pendingB);
    expect(changesLeft).toBe(true);
    expect(delayed).toEqual(retryB);
    expect(storage.copyObject).not.toHaveBeenCalled();
    expect(storage.deletePath).not.toHaveBeenCalled();
    expect(taskResult.updateIf).not.toHaveBeenCalled();
    expect(taskResult.deleteChangesIf).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(await drainRetries()).toBe(1);
    expect(row).toBeNull();
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
    expect(storage.copyObject.mock.calls[0][1]).toBe('documentsave-B/output.docx');
  });

  test("a redelivered original of a declined save leaves a newer save's row alone", async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    const original = queued();
    await deliver(original);
    expect(row.status).toBe(SaveVersion);
    now += 120000;
    newerSaveTakesRow();
    const newerRow = {...row};

    await deliver(original);

    expect(row).toEqual(newerRow);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
    expect(storage.copyObject).toHaveBeenCalledTimes(1);
  });

  test('the forgotten-file cleanup leaves a session opened meanwhile alone', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    const editorDataCleanup = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');
    storage.copyObject.mockImplementationOnce(async () => {
      // A user opens while the forgotten file is copied.
      row.status = Ok;
      row.status_info = constants.NO_ERROR;
    });

    await deliver(queued());
    await drainRetries();

    expect(editorDataCleanup).not.toHaveBeenCalled();
    expect(row.status).toBe(Ok);
    expect(taskResult.claimIf).not.toHaveBeenCalled();
  });

  test('a declined retry that finds its row removed restores nothing', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    expect(row).toBeNull();
    const updates = taskResult.updateIf.mock.calls.length;

    expect(await drainRetries()).toBe(1);

    expect(taskResult.updateIf.mock.calls.length).toBe(updates);
    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
  });

  test('an HTTP retry whose publication fails keeps its HTTP attempt', async () => {
    useFastBackoff();
    docsCoServer.sendServerRequest.mockRejectedValueOnce(Object.assign(new Error('callback unavailable'), {statusCode: 503}));
    docsCoServer.addDelayed.mockImplementationOnce(function* () {
      yield Promise.reject(new Error('broker unavailable'));
    });

    await deliver(queued());

    expect(delayed).toHaveLength(1);
    const retry = new commonDefines.TaskQueueData(JSON.parse(delayed[0].data)).getCmd();
    expect(retry.getCallbackAttempt() || 0).toBe(0);
  });

  test.each(['reopened', 'newer save', 'recreated row'])('a notification retry does not publish after takeover by a %s', async takeover => {
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    expectCompleted();
    expect(delayed).toHaveLength(1);
    if (takeover === 'reopened') {
      row.status = Ok;
      row.status_info = constants.NO_ERROR;
    } else if (takeover === 'newer save') {
      // Its reusable minute status is the same as the old completion's.
      newerSaveTakesRow();
    } else {
      row = {...row, additional: '', status: UpdateVersion, status_info: minute(), callback: 'new callback'};
    }
    const newerRow = {...row};
    docsCoServer.publish.mockClear();
    taskResult.updateIf.mockClear();

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(taskResult.updateIf).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(0);
    expect(row).toEqual(newerRow);
  });

  test.each([true, false])('a notification retry after row removal detects a new session (accepted: %s)', async accepted => {
    if (accepted) {
      storage.listObjects.mockImplementation(async (_ctx, path) =>
        path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']
      );
    } else {
      docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    }
    const newSession = {...row, status: Ok, status_info: constants.NO_ERROR};
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    expect(row).toBeNull();
    expect(delayed).toHaveLength(1);
    row = newSession;
    docsCoServer.publish.mockClear();

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(row).toEqual(newSession);
    expect(delayed).toHaveLength(0);
  });

  test('a notification retry retains the original owner after ancillary metadata changes', async () => {
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    row.additional += sqlBase.DocumentAdditional.prototype.setShardKey('new shard metadata');
    now += 90000;

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expectCompleted();
  });

  test('a notification retry still publishes after its forgotten-file session removed the row', async () => {
    storage.listObjects.mockImplementation(async (_ctx, path) => (path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']));
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    expect(row).toBeNull();
    expect(delayed).toHaveLength(1);

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expect(docsCoServer.publish).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({success: true}));
    expect(row).toBeNull();
  });

  test.each([false, true])('a notification retry without final-save markers checks its session (takeover: %s)', async takeover => {
    row.additional = undefined;
    row.callback = 'https://callback.example.test/secret-token';
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    expect(delayed).toHaveLength(1);
    expect(delayed[0].data).not.toContain('secret-token');
    if (takeover) {
      // A new row with the same reusable status and minute must not pass.
      row.callback = 'https://callback.example.test/new-session';
    }

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).toHaveBeenCalledTimes(takeover ? 1 : 2);
  });

  test.each([false, true])('a close-without-changes notification retry checks its session (takeover: %s)', async takeover => {
    newerSaveTakesRow();
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued({status_info: constants.EDITOR_CHANGES}));
    expect(delayed).toHaveLength(1);
    if (takeover) {
      row.callback = 'new session callback';
    }

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).toHaveBeenCalledTimes(takeover ? 1 : 2);
  });

  test.each([false, true])('a notification retry queued before ownership snapshots checks the final-save marker (takeover: %s)', async takeover => {
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    const legacy = JSON.parse(delayed[0].data);
    delete legacy.cmd.updateVersionOwner;
    delayed[0].data = JSON.stringify(legacy);
    if (takeover) {
      newerSaveTakesRow();
    }

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).toHaveBeenCalledTimes(takeover ? 1 : 2);
  });

  test('a notification retry rechecks ownership after waiting for the row lock', async () => {
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    await deliver(queued());
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementationOnce(async (...args) => {
      newerSaveTakesRow();
      return withOwnership(...args);
    });
    docsCoServer.publish.mockClear();

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(0);
  });

  test('a failed updateVersion publication is retried on its own, after the save completed', async () => {
    docsCoServer.publish.mockRejectedValueOnce(new Error('publication unavailable'));
    const editorDataCleanup = jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit');

    await deliver(queued());
    // Completed before the event.
    expectCompleted();
    expect(delayed).toHaveLength(1);
    const cleanups = editorDataCleanup.mock.calls.length;

    expect(await drainRetries()).toBe(1);

    expect(docsCoServer.publish).toHaveBeenCalledTimes(2);
    expect(editorDataCleanup.mock.calls.length).toBe(cleanups);
    expect(docsCoServer.sendServerRequest).toHaveBeenCalledTimes(1);
  });

  test("a forgotten-file session's cache and row are gone before editors are told", async () => {
    storage.listObjects.mockImplementation(async (_ctx, path) => (path.endsWith('.txt') ? ['document/forgotten.txt'] : ['document/forgotten.docx']));
    const atPublish = [];
    docsCoServer.publish.mockImplementation(async () => {
      atPublish.push(row);
    });

    await deliver(queued());

    expect(atPublish).toEqual([null]);
  });

  test('a declined retry does not rebuild the callback it will not send', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValueOnce(new Error('forgotten storage unavailable'));
    await deliver(queued());
    // Storage reads for the callback payload would fail now.
    storage.getSignedUrl.mockRejectedValue(new Error('storage unavailable'));
    storage.getObject.mockRejectedValue(new Error('storage unavailable'));

    expect(await drainRetries()).toBe(1);

    // The forgotten file is stored and the row removed, as without the outage.
    expect(storage.copyObject).toHaveBeenCalledTimes(2);
    expect(row).toBeNull();
  });

  test("a pending claim after another save's marker (a WOPI invalidation) expires at once", async () => {
    const original = queued();
    await deliver(original);
    expectCompleted();
    row.status_info = commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 3 + 12345;
    expect(canvasservice.isUpdateVersionExpired(new operationContext.Context(), row, 5 * 60000)).toBe(true);
  });

  test('giving up while restored to SaveVersion still tells waiting editors', async () => {
    docsCoServer.sendServerRequest.mockResolvedValue('{"error":1}');
    storage.copyObject.mockRejectedValue(new Error('forgotten storage unavailable'));

    await deliver(queued());
    await drainRetries({limit: 100});

    expect(row.status).toBe(SaveVersion);
    expect(docsCoServer.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion, success: false})
    );
  });

  test('the "closed without changes" status is sent once across cleanup retries', async () => {
    row.status = Ok;
    row.status_info = constants.NO_ERROR;
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockResolvedValue([]);
    const statusRequests = jest.spyOn(utils, 'postRequestPromise').mockResolvedValue({response: {headers: {}}, body: '{"error":0}'});
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockRejectedValueOnce(new Error('editor data unavailable'));

    await deliver(queued({status_info: constants.EDITOR_CHANGES}));
    expect(statusRequests).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(1);
    expect(await drainRetries()).toBe(1);

    expect(delayed).toHaveLength(0);
    expect(statusRequests).toHaveBeenCalledTimes(1);
    expect(docsCoServer.editorData.cleanDocumentOnExit).toHaveBeenCalledTimes(2);
  });

  test('an open does not take over a save whose callback is still in flight past expire.updateVersionStatus', async () => {
    const ctx = new operationContext.Context();
    ctx.setTenant(tenant);
    const checks = [];
    docsCoServer.sendServerRequest.mockImplementation(async () => {
      // The integrator answers after six minutes (the callback timeout is ten);
      // an open and a WOPI cache check come in meanwhile.
      now += 6 * 60000;
      checks.push(canvasservice.isUpdateVersionExpired(ctx, {...row}, 5 * 60000), canvasservice.isFinalSaveInProgress(ctx, {...row}));
      return '{"error":0}';
    });

    await deliver(queued());

    expect(checks).toEqual([false, true]);
    expectCompleted();
    expect(docsCoServer.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({type: commonDefines.c_oPublishType.updateVersion, success: true})
    );
  });

  test('a callback in flight holds its row only until its timeout and expire.updateVersionStatus have passed', async () => {
    const ctx = new operationContext.Context();
    const expire = 5 * 60000;
    const callbackTimeout = 10 * 60000;
    row.status = UpdateVersion;
    row.status_info = minute();
    const data = new sqlBase.DocumentAdditional();
    data.data.push({[MARKER]: {operationId: 'save-key', phase: 'sending', openFromForgotten: false, since: now}});
    row.additional += data.toSQLInsert();
    const completed = {...row, additional: row.additional.replace('"sending"', '"accepted"')};
    const start = now;

    now = start + callbackTimeout + expire - 1000;
    expect(canvasservice.isUpdateVersionExpired(ctx, row, expire)).toBe(false);
    expect(canvasservice.isFinalSaveInProgress(ctx, row)).toBe(true);
    now = start + callbackTimeout + expire + 1000;
    expect(canvasservice.isUpdateVersionExpired(ctx, row, expire)).toBe(true);
    expect(canvasservice.isFinalSaveInProgress(ctx, row)).toBe(false);
    // A completed save's minute (its acceptance last) expires.
    now = start + expire + 1000;
    expect(canvasservice.isUpdateVersionExpired(ctx, completed, expire)).toBe(true);
    expect(canvasservice.isFinalSaveInProgress(ctx, completed)).toBe(false);
  });

  test('the WOPI cache check leaves every pending status alone, cleanup claims included', async () => {
    const ctx = new operationContext.Context();
    row.status = UpdateVersion;
    for (const statusInfo of [
      commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO,
      commonDefines.CALLBACK_ACCEPTED_STATUS_INFO,
      commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO,
      commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 3 + 12345
    ]) {
      row.status_info = statusInfo;
      expect(canvasservice.isFinalSaveInProgress(ctx, row)).toBe(true);
    }
    // A minute with no save in flight: the cache check goes ahead.
    row.status_info = minute();
    expect(canvasservice.isFinalSaveInProgress(ctx, row)).toBe(false);
  });

  test('a dead-letter round waits as long as the infrastructure retry it uses up', async () => {
    const ctx = new operationContext.Context();
    const options = config.get('services.CoAuthoring.callbackBackoffOptions');
    const {createTimeout} = require('../../DocService/node_modules/retry');
    let total = 0;
    for (let i = 0; i < options.infraRetries; ++i) {
      const cmd = command();
      // HTTP callback attempts do not count.
      cmd.setCallbackAttempt(2);
      cmd.setAttempt(i + 2);
      const delay = canvasservice.getSfcInfraRetryDelay(ctx, cmd);
      expect(delay).toBe(createTimeout(Math.min(i, 3), options.timeout));
      total += delay;
    }
    // The budget lasts the retry window, not infraRetries short rounds.
    expect(total).toBeGreaterThan(7 * 60000);
  });

  test.each([
    ['declined', async () => '{"error":1}'],
    [
      'a retryable failure',
      async () => {
        throw Object.assign(new Error('integrator unavailable'), {statusCode: 503});
      }
    ]
  ])('a save (%s) whose row an open took over stores no forgotten file and tells no one', async (_name, answer) => {
    docsCoServer.sendServerRequest.mockImplementation(async () => {
      // The attempt stalled past its expiry: an open took the row over and
      // resumed the session with the changes.
      row.status = Ok;
      row.status_info = constants.NO_ERROR;
      return answer();
    });

    await deliver(queued());

    expect(storage.copyObject).not.toHaveBeenCalled();
    expect(taskResult.claimIf).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(0);
    expect(row.status).toBe(Ok);
    expect(changesLeft).toBe(true);
    expect(docsCoServer.editorData.savedCallbackAccepted).toEqual({});
  });

  test.each([false, true])('a declined save whose row was removed cannot copy into a new session (reopened: %s)', async reopened => {
    const initialRow = {...row};
    docsCoServer.sendServerRequest.mockImplementation(async () => {
      row = null;
      return '{"error":1}';
    });
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementation(async (...args) => {
      if (reopened) {
        row = {...initialRow};
        newerSaveTakesRow();
      }
      return withOwnership(...args);
    });

    await deliver(queued());
    await drainRetries();

    expect(storage.copyObject).not.toHaveBeenCalled();
    expect(storage.deletePath).not.toHaveBeenCalled();
    expect(taskResult.deleteChangesIf).not.toHaveBeenCalled();
    expect(taskResult.removeIf).not.toHaveBeenCalled();
    expect(docsCoServer.publish).not.toHaveBeenCalled();
    expect(delayed).toHaveLength(0);
  });
  test.each([false, true])('cleanup and publication need no second SQL connection (WOPI: %s)', async wopi => {
    if (wopi) {
      fakeWopiHost();
    }
    let locked = false;
    const select = taskResult.select.getMockImplementation();
    taskResult.select.mockImplementation(async (...args) => {
      if (locked) {
        throw new Error('pool exhausted: ownership action requested another connection');
      }
      return select(...args);
    });
    const withOwnership = taskResult.withCleanupOwnership.getMockImplementation();
    taskResult.withCleanupOwnership.mockImplementation((ctx, mask, action) =>
      withOwnership(ctx, mask, async lockedRow => {
        locked = true;
        try {
          await action(lockedRow);
        } finally {
          locked = false;
        }
      })
    );

    await deliver(queued());

    expectCompleted();
    expect(docsCoServer.publish).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveLength(0);
    if (wopi) {
      expect(row.callback).toContain('unlockId');
    }
  });
});
