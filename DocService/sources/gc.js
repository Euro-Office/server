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
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';

const config = require('config');
const co = require('co');
const ms = require('ms');
const taskResult = require('./taskresult');
const docsCoServer = require('./DocsCoServer');
const canvasService = require('./canvasservice');
const commondefines = require('./../../Common/sources/commondefines');
const queueService = require('./../../Common/sources/taskqueueRabbitMQ');
const operationContext = require('./../../Common/sources/operationContext');
const pubsubService = require('./pubsubRabbitMQ');
const sqlBase = require('./databaseConnectors/baseConnector');
const {getCronStep, validateDocumentExpiryConfig} = require('./expirationConfig');

const cfgExpFilesCron = config.get('services.CoAuthoring.expire.filesCron');
const cfgExpDocumentsCron = config.get('services.CoAuthoring.expire.documentsCron');
const cfgExpPresence = config.get('services.CoAuthoring.expire.presence');
const cfgExpShard = config.get('services.CoAuthoring.expire.shard');
const cfgExpFiles = config.get('services.CoAuthoring.expire.files');
const cfgExpFilesRemovedAtOnce = config.get('services.CoAuthoring.expire.filesremovedatonce');
const cfgForceSaveStep = config.get('services.CoAuthoring.autoAssembly.step');

const baseDocumentExpiryConfig = validateDocumentExpiryConfig({
  documentsCron: cfgExpDocumentsCron,
  presence: cfgExpPresence,
  shard: cfgExpShard
});
if (!baseDocumentExpiryConfig.valid) {
  throw new Error(baseDocumentExpiryConfig.message);
}
const expFilesStep = getCronStep(cfgExpFilesCron);
const expDocumentsStep = baseDocumentExpiryConfig.documentsCronStepMs;

function acknowledgeExpired(editorData, method, item) {
  const acknowledge = editorData[method];
  return typeof acknowledge === 'function' ? acknowledge.call(editorData, item) : undefined;
}

function acknowledgeForceSaveResult(ctx, expiredKey, result) {
  if (!result || result.code !== commondefines.c_oAscServerCommandErrors.NoError) {
    ctx.logger.error(
      'forceSaveTimeout item failed: tenant=%s docId=%s code=%s',
      expiredKey[0],
      expiredKey[1],
      result && result.code !== undefined ? result.code : 'missing'
    );
    return Promise.resolve();
  }
  return acknowledgeExpired(docsCoServer.editorData, '_ackForceSaveTimer', expiredKey);
}

function needsExpirationFollowUp(expiredKeys) {
  // The editor-data implementation owns its queue limits and reports whether
  // another bounded claim is needed; GC does not need to know how that signal
  // was calculated or which storage backend supplied it. A failed shard also
  // requests a later retry, but uses the normal interval to avoid a tight loop
  // while the shard is unavailable.
  return Array.isArray(expiredKeys) && expiredKeys.hasMore === true && expiredKeys.hasShardFailure !== true;
}

async function processForceSaveItem(ctx, expiredKey, queue, pubsub) {
  const tenant = expiredKey[0];
  const docId = expiredKey[1];
  let itemCtx = null;

  try {
    // Each force-save can stay async for a while. Give it its own context so a
    // later item cannot change the tenant or document underneath it. Keeping
    // this whole lifecycle in the item promise also lets tenant initialization
    // happen in parallel with other items.
    itemCtx = new operationContext.Context();
    itemCtx.init(tenant, docId, ctx.userId);
    await itemCtx.initTenantCache();
    //todo opt_initShardKey from ForceSave data or from db

    const result = await docsCoServer.startForceSave(
      itemCtx,
      docId,
      commondefines.c_oAscForceSaveTypes.Timeout,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      queue,
      pubsub,
      undefined,
      true
    );
    await acknowledgeForceSaveResult(itemCtx, expiredKey, result);
  } catch (error) {
    // Keep the claim unacknowledged so Redis can retry this item, while
    // continuing with the next item in this bounded pass.
    (itemCtx || ctx).logger.error('forceSaveTimeout item error: tenant=%s docId=%s: %s', tenant, docId, error && error.stack ? error.stack : error);
  }
}

async function processDocumentExpireItem(ctx, expiredKey, state, queue) {
  const tenant = expiredKey[0];
  const docId = expiredKey[1];
  let startSaveCount = 0;
  let removedCount = 0;

  if (docId) {
    if (state.currentTenant !== tenant) {
      ctx.init(tenant, docId, ctx.userId);
      await ctx.initTenantCache();
      state.currentTenant = tenant;
    } else {
      ctx.setDocId(docId);
    }

    const hasChanges = await docsCoServer.hasChanges(ctx, docId);
    if (hasChanges) {
      //todo opt_initShardKey from getDocumentPresenceExpired data or from db
      await docsCoServer.createSaveTimer(ctx, docId, null, null, null, queue, true, true);
      startSaveCount++;
    } else {
      await docsCoServer.cleanDocumentOnExitNoChangesPromise(ctx, docId);
      removedCount++;
    }
  }

  const acknowledged = await acknowledgeExpired(docsCoServer.editorData, '_ackDocumentPresenceExpired', expiredKey);
  return {acknowledged, startSaveCount, removedCount};
}

async function processDocumentExpireItems(ctx, expiredKeys, state, queue) {
  let removedCount = 0;
  let startSaveCount = 0;

  for (const expiredKey of expiredKeys) {
    const tenant = expiredKey[0];
    const docId = expiredKey[1];
    try {
      const result = await processDocumentExpireItem(ctx, expiredKey, state, queue);
      startSaveCount += result.startSaveCount;
      removedCount += result.removedCount;
      if (result.acknowledged === false) {
        ctx.logger.warn('checkDocumentExpire item was not acknowledged: tenant=%s docId=%s', tenant, docId);
      }
    } catch (error) {
      // Leave failed claims unacknowledged so Redis can reclaim them after the existing lease.
      ctx.logger.error('checkDocumentExpire document error: tenant=%s docId=%s: %s', tenant, docId, error && error.stack ? error.stack : error);
    }
  }

  return {startSaveCount, removedCount};
}

const checkFileExpire = function (expireSeconds) {
  return co(function* () {
    const ctx = new operationContext.Context();
    let currentExpFilesStep = expFilesStep;
    try {
      ctx.logger.info('checkFileExpire start');
      yield ctx.initTenantCache();
      const expFiles = ctx.getCfg('services.CoAuthoring.expire.files', cfgExpFiles);
      const expFilesRemovedAtOnce = ctx.getCfg('services.CoAuthoring.expire.filesremovedatonce', cfgExpFilesRemovedAtOnce);
      const currentFilesCron = ctx.getCfg('services.CoAuthoring.expire.filesCron', cfgExpFilesCron);
      currentExpFilesStep = getCronStep(currentFilesCron);

      let removedCount = 0;
      let expired;
      let currentRemovedCount;
      do {
        currentRemovedCount = 0;
        expired = yield taskResult.getExpired(ctx, expFilesRemovedAtOnce, expireSeconds ?? expFiles);

        expired.sort((a, b) => a.tenant.localeCompare(b.tenant));
        let currentTenant = null;

        for (let i = 0; i < expired.length; ++i) {
          const tenant = expired[i].tenant;
          const docId = expired[i].id;
          const shardKey = sqlBase.DocumentAdditional.prototype.getShardKey(expired[i].additional);
          const wopiSrc = sqlBase.DocumentAdditional.prototype.getWopiSrc(expired[i].additional);

          try {
            if (currentTenant !== tenant) {
              ctx.init(tenant, docId, ctx.userId, shardKey, wopiSrc);
              yield ctx.initTenantCache();
              currentTenant = tenant;
            } else {
              ctx.setDocId(docId);
              ctx.setShardKey(shardKey);
              ctx.setWopiSrc(wopiSrc);
            }

            //todo tenant
            //check that no one is in the document
            const editorsCount = yield docsCoServer.getEditorsCountPromise(ctx, docId);
            if (0 === editorsCount) {
              if (yield canvasService.cleanupCache(ctx, docId)) {
                currentRemovedCount++;
              }
            } else {
              ctx.logger.debug('checkFileExpire expire but presence: editorsCount = %d', editorsCount);
            }
          } catch (error) {
            ctx.logger.error('checkFileExpire file error: %s', error.stack);
            // Continue processing other files
          }
        }
        removedCount += currentRemovedCount;
      } while (currentRemovedCount > 0);
      ctx.initDefault();
      ctx.logger.info('checkFileExpire end: removedCount = %d', removedCount);
    } catch (e) {
      ctx.logger.error('checkFileExpire error: %s', e.stack);
    } finally {
      setTimeout(checkFileExpire, currentExpFilesStep);
    }
  });
};
const checkDocumentExpire = function () {
  return co(function* () {
    let queue = null;
    let removedCount = 0;
    let startSaveCount = 0;
    let drainRequested = false;
    let currentExpDocumentsStep = expDocumentsStep;
    const ctx = new operationContext.Context();
    try {
      ctx.logger.info('checkDocumentExpire start');
      const currentDocumentsCron = ctx.getCfg('services.CoAuthoring.expire.documentsCron', cfgExpDocumentsCron);
      const currentDocumentExpiryConfig = validateDocumentExpiryConfig({
        documentsCron: currentDocumentsCron,
        presence: ctx.getCfg('services.CoAuthoring.expire.presence', cfgExpPresence),
        shard: ctx.getCfg('services.CoAuthoring.expire.shard', cfgExpShard)
      });
      if (!currentDocumentExpiryConfig.valid) {
        ctx.logger.error('checkDocumentExpire configuration error: %s', currentDocumentExpiryConfig.message);
        return;
      }
      currentExpDocumentsStep = currentDocumentExpiryConfig.documentsCronStepMs;
      yield ctx.initTenantCache();
      const expiredKeys = yield docsCoServer.editorData.getDocumentPresenceExpired();
      drainRequested = needsExpirationFollowUp(expiredKeys);
      if (expiredKeys.length > 0) {
        queue = new queueService();
        yield queue.initPromise(true, false, false, false, false, false);

        expiredKeys.sort((a, b) => a[0].localeCompare(b[0]));
        const state = {currentTenant: null};
        const result = yield processDocumentExpireItems(ctx, expiredKeys, state, queue);
        startSaveCount += result.startSaveCount;
        removedCount += result.removedCount;
      }
      ctx.initDefault();
      ctx.logger.info('checkDocumentExpire end: startSaveCount = %d, removedCount = %d', startSaveCount, removedCount);
    } catch (e) {
      ctx.logger.error('checkDocumentExpire error: %s', e.stack);
    } finally {
      try {
        if (queue) {
          yield queue.close();
        }
      } catch (e) {
        ctx.logger.error('checkDocumentExpire error: %s', e.stack);
      }

      // A full claim means there may be more expired work. Schedule one more
      // bounded pass immediately; an empty/partial claim returns to the normal
      // interval. This drains sustained auto-save pressure without turning a
      // single GC invocation into an unbounded loop.
      setTimeout(checkDocumentExpire, drainRequested ? 0 : currentExpDocumentsStep);
    }
  });
};
const forceSaveTimeout = function () {
  return co(function* () {
    let queue = null;
    let pubsub = null;
    let drainRequested = false;
    let currentForceSaveStep = cfgForceSaveStep;
    const ctx = new operationContext.Context();
    try {
      ctx.logger.info('forceSaveTimeout start');
      yield ctx.initTenantCache();
      currentForceSaveStep = ctx.getCfg('services.CoAuthoring.autoAssembly.step', cfgForceSaveStep);
      const now = new Date().getTime();
      const expiredKeys = yield docsCoServer.editorData.getForceSaveTimer(now);
      drainRequested = needsExpirationFollowUp(expiredKeys);
      if (expiredKeys.length > 0) {
        queue = new queueService();
        yield queue.initPromise(true, false, false, false, false, false);

        pubsub = new pubsubService();
        yield pubsub.initPromise();

        expiredKeys.sort((a, b) => a[0].localeCompare(b[0]));

        const actions = [];

        for (let i = 0; i < expiredKeys.length; ++i) {
          const expiredKey = expiredKeys[i];
          const docId = expiredKey[1];
          if (docId) {
            actions.push(processForceSaveItem(ctx, expiredKey, queue, pubsub));
          } else {
            actions.push(Promise.resolve(acknowledgeExpired(docsCoServer.editorData, '_ackForceSaveTimer', expiredKey)));
          }
        }
        yield Promise.all(actions);
        ctx.logger.debug('forceSaveTimeout actions.length %d', actions.length);
      }
      ctx.initDefault();
      ctx.logger.info('forceSaveTimeout end');
    } catch (e) {
      ctx.logger.error('forceSaveTimeout error: %s', e.stack);
    } finally {
      try {
        if (queue) {
          yield queue.close();
        }
        if (pubsub) {
          yield pubsub.close();
        }
      } catch (e) {
        ctx.logger.error('forceSaveTimeout cleanup error: %s', e.stack);
      }
      // Keep force-save expiration on the same bounded continuation policy as
      // document presence expiration. This is important when auto-save keeps
      // producing timers faster than one 96-item pass can process them.
      setTimeout(forceSaveTimeout, drainRequested ? 0 : ms(currentForceSaveStep));
    }
  });
};

exports.startGC = function () {
  //runtime config is read on start
  setTimeout(checkDocumentExpire, expDocumentsStep);
  setTimeout(checkFileExpire, expFilesStep);
  setTimeout(forceSaveTimeout, ms(cfgForceSaveStep));
};
exports.getCronStep = getCronStep;
exports.checkFileExpire = checkFileExpire;
exports.checkDocumentExpire = checkDocumentExpire;
exports.forceSaveTimeout = forceSaveTimeout;
