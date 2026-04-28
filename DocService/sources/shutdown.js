/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-6 Ernesta Birznieka-Upish
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';
const config = require('config');
const configCoAuthoring = config.get('services.CoAuthoring');
const co = require('co');
const pubsubService = require('./pubsubRabbitMQ');
const sqlBase = require('./databaseConnectors/baseConnector');
const commonDefines = require('./../../Common/sources/commondefines');
const constants = require('./../../Common/sources/constants');
const utils = require('./../../Common/sources/utils');
const storage = require('./../../Common/sources/storage/storage-base');
const taskResult = require('./taskresult');

const cfgForgottenFiles = configCoAuthoring.get('server.forgottenfiles');
const cfgTableResult = configCoAuthoring.get('sql.tableResult');
const cfgRedisPrefix = configCoAuthoring.get('redis.prefix');
const redisKeyShutdown = cfgRedisPrefix + constants.REDIS_KEY_SHUTDOWN;

const WAIT_TIMEOUT = 30000;
const LOOP_TIMEOUT = 1000;
const EXEC_TIMEOUT = WAIT_TIMEOUT + utils.getConvertionTimeout(undefined);

/**
 * UPDATE task_result SET status=Ok, callback='' WHERE tenant=? AND id=?.
 * Writes literal '' — NOT the UserCallback JSON envelope that taskResult.update() produces.
 */
function clearCallback(ctx, docId) {
  return new Promise((resolve, reject) => {
    const values = [];
    const p1 = sqlBase.addSqlParameter(commonDefines.FileStatus.Ok, values);
    const p2 = sqlBase.addSqlParameter('', values);
    const p3 = sqlBase.addSqlParameter(ctx.tenant, values);
    const p4 = sqlBase.addSqlParameter(docId, values);
    const sql = `UPDATE ${cfgTableResult} SET status=${p1},callback=${p2} WHERE tenant=${p3} AND id=${p4};`;
    sqlBase.sqlQuery(ctx, sql, (err, res) => (err ? reject(err) : resolve(res)), undefined, undefined, values);
  });
}

/**
 * Phase 2: recover documents that have leftover changes in the DB but no fresh forgotten file.
 * Destructive: clears callback, deletes doc_changes rows, removes forgotten storage.
 * Fixes two pre-existing defects in the standalone changes2forgotten script:
 *  - WOPI unlock executed BEFORE callback is cleared (otherwise wopiParams are lost).
 *  - Direct call to cleanDocumentOnExitNoChangesPromise (no createSaveTimer indirection).
 */
function* recoverChanges(ctx) {
  const docsCoServer = require('./DocsCoServer');
  const documentsWithChanges = yield sqlBase.getDocumentsWithChanges(ctx);
  ctx.logger.debug('shutdown phase2 docs with changes = %s', documentsWithChanges.length);

  const docsToConvert = [];
  for (let i = 0; i < documentsWithChanges.length; ++i) {
    const tenant = documentsWithChanges[i].tenant;
    const docId = documentsWithChanges[i].id;
    ctx.setTenant(tenant);
    yield ctx.initTenantCache();
    const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
    const forgotten = yield storage.listObjects(ctx, docId, tenForgottenFiles);
    if (forgotten.length > 0) {
      const selectRes = yield taskResult.select(ctx, docId);
      if (selectRes.length > 0) {
        const row = selectRes[0];
        if (row.status !== commonDefines.FileStatus.SaveVersion && row.status !== commonDefines.FileStatus.UpdateVersion) {
          docsToConvert.push([tenant, docId]);
        }
      }
    } else {
      docsToConvert.push([tenant, docId]);
    }
  }
  ctx.initDefault();
  ctx.logger.debug('shutdown phase2 docs to recover = %s', docsToConvert.length);

  for (let i = 0; i < docsToConvert.length; ++i) {
    const tenant = docsToConvert[i][0];
    const docId = docsToConvert[i][1];
    ctx.setTenant(tenant);
    yield ctx.initTenantCache();

    // Defensive re-check: a peer node could have completed a save between enumeration and processing.
    const recheck = yield taskResult.select(ctx, docId);
    if (
      recheck.length > 0 &&
      (recheck[0].status === commonDefines.FileStatus.SaveVersion || recheck[0].status === commonDefines.FileStatus.UpdateVersion)
    ) {
      ctx.logger.debug('shutdown phase2 skip (status changed) %s', docId);
      continue;
    }

    // Unlock WOPI BEFORE clearing the callback (mirrors canvasservice storeForgotten pattern).
    yield docsCoServer.unlockWopiDoc(ctx, docId);

    // Clear callback to literal '' so cleanup proceeds without sending integrator notification.
    yield clearCallback(ctx, docId);

    ctx.logger.debug('shutdown phase2 cleanup %s', docId);
    yield docsCoServer.cleanDocumentOnExitNoChangesPromise(ctx, docId, null, null, false, true);
  }
  ctx.initDefault();
  // Wait for the fire-and-forget sqlBase.deleteChanges to land before verifying.
  yield utils.sleep(LOOP_TIMEOUT);

  // Verification pass: confirm processed docs no longer have changes in the DB.
  const remaining = yield sqlBase.getDocumentsWithChanges(ctx);
  const remainingSet = new Set(remaining.map(r => `${r.tenant}\x00${r.id}`));
  let cleaned = 0;
  for (let i = 0; i < docsToConvert.length; ++i) {
    const [tenant, docId] = docsToConvert[i];
    if (!remainingSet.has(`${tenant}\x00${docId}`)) {
      cleaned++;
    } else {
      ctx.logger.warn('shutdown phase2 still has changes:%s', docId);
    }
  }
  ctx.logger.debug('shutdown phase2 cleaned:%d still_pending:%d', cleaned, docsToConvert.length - cleaned);
}

exports.shutdown = function (ctx, editorStat, status) {
  return co(function* () {
    let res = true;
    try {
      ctx.logger.debug('shutdown start:' + EXEC_TIMEOUT);

      //redisKeyShutdown is not a simple counter, so it doesn't get decremented by a build that started before Shutdown started
      //reset redisKeyShutdown just in case the previous run didn't finish
      yield editorStat.cleanupShutdown(redisKeyShutdown);

      const pubsub = new pubsubService();
      yield pubsub.initPromise();
      //inner ping to update presence
      ctx.logger.debug('shutdown pubsub shutdown message');
      yield pubsub.publish(JSON.stringify({type: commonDefines.c_oPublishType.shutdown, ctx, status}));
      //wait while pubsub deliver and start conversion
      ctx.logger.debug('shutdown start wait pubsub deliver');
      const startTime = new Date().getTime();
      let isStartWait = true;
      while (true) {
        const curTime = new Date().getTime() - startTime;
        if (isStartWait && curTime >= WAIT_TIMEOUT) {
          isStartWait = false;
          ctx.logger.debug('shutdown stop wait pubsub deliver');
        } else if (curTime >= EXEC_TIMEOUT) {
          res = false;
          ctx.logger.debug('shutdown timeout');
          break;
        }
        const remainingFiles = yield editorStat.getShutdownCount(redisKeyShutdown);
        const inSavingStatus = yield sqlBase.getCountWithStatus(ctx, commonDefines.FileStatus.SaveVersion, EXEC_TIMEOUT);
        ctx.logger.debug('shutdown remaining files editorStat:%d, db:%d', remainingFiles, inSavingStatus);
        if (!isStartWait && remainingFiles + inSavingStatus <= 0) {
          break;
        }
        yield utils.sleep(LOOP_TIMEOUT);
      }
      // Phase 2: recover orphan DB changes (only on shutdown, not uncordon).
      // Skip if Phase 1 timed out — active saves may still be in progress.
      if (status && res) {
        yield* recoverChanges(ctx);
      }

      //todo need to check the queues, because there may be long conversions running before Shutdown
      //clean up
      yield editorStat.cleanupShutdown(redisKeyShutdown);
      yield pubsub.close();

      ctx.logger.debug('shutdown end');
    } catch (e) {
      res = false;
      ctx.logger.error('shutdown error: %s', e.stack);
    }
    return res;
  });
};
