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
const {
  DEFAULT_FILES_CRON_STEP_MS,
  cronStepMs,
  documentExpiryTtlsApply,
  getCronStep,
  resolveDocumentExpiryStep,
  setDocumentsExpireStepMs
} = require('./expirationConfig');
const {POP_EXPIRED_LEASE_MS} = require('./editorDataRedis/editorDataSettings');

const cfgExpFilesCron = config.get('services.CoAuthoring.expire.filesCron');
const cfgExpDocumentsCron = config.get('services.CoAuthoring.expire.documentsCron');
const cfgExpPresence = config.get('services.CoAuthoring.expire.presence');
// New in the Redis editor-data release: keep its default.json value as a
// fallback, so that an older operator-supplied default.json still starts.
const cfgExpShard = config.has('services.CoAuthoring.expire.shard') ? config.get('services.CoAuthoring.expire.shard') : 300;
const cfgExpFiles = config.get('services.CoAuthoring.expire.files');
const cfgExpFilesRemovedAtOnce = config.get('services.CoAuthoring.expire.filesremovedatonce');
const cfgForceSaveStep = config.get('services.CoAuthoring.autoAssembly.step');
const cfgEditorDataStorage = config.get('services.CoAuthoring.server.editorDataStorage');
const cfgEditorStatStorage = config.get('services.CoAuthoring.server.editorStatStorage');

const checkExpiryTtls = documentExpiryTtlsApply(cfgEditorDataStorage, cfgEditorStatStorage);
// A documentsCron that is too slow for the Redis TTLs is shortened, not
// rejected: it may come from the AdminPanel's runtime.json, which is merged into
// the startup config, and rejecting it would stop every DocService.
const baseDocumentExpiryConfig = resolveDocumentExpiryStep(
  {
    documentsCron: cfgExpDocumentsCron,
    presence: cfgExpPresence,
    shard: cfgExpShard
  },
  undefined,
  {checkTtls: checkExpiryTtls}
);
if (!baseDocumentExpiryConfig.valid) {
  throw new Error(baseDocumentExpiryConfig.message);
}
const baseFilesCronStep = cronStepMs(cfgExpFilesCron, 'services.CoAuthoring.expire.filesCron', DEFAULT_FILES_CRON_STEP_MS);
const expFilesStep = baseFilesCronStep.stepMs;
const expDocumentsStep = baseDocumentExpiryConfig.stepMs;
setDocumentsExpireStepMs(expDocumentsStep);

function acknowledgeExpired(editorData, method, item) {
  const acknowledge = editorData[method];
  return typeof acknowledge === 'function' ? acknowledge.call(editorData, item) : undefined;
}

// Outcomes that a later attempt cannot change: the force-save started, there
// was nothing to save (NotModified: no unsaved changes since the last
// force-save, one is already running, or the document has no callback), or the
// document is gone (DocumentIdError).  Acknowledge them so the leased timer is
// not handed out again every lease period; the in-memory backend drops every
// popped timer.  Other results and exceptions keep the lease for a retry.
const FINAL_FORCE_SAVE_TIMER_CODES = new Set([
  commondefines.c_oAscServerCommandErrors.NoError,
  commondefines.c_oAscServerCommandErrors.NotModified,
  commondefines.c_oAscServerCommandErrors.DocumentIdError
]);

function acknowledgeForceSaveResult(ctx, expiredKey, result) {
  if (!result || !FINAL_FORCE_SAVE_TIMER_CODES.has(result.code)) {
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

// A claimed batch is leased for POP_EXPIRED_LEASE_MS; then any instance can
// claim its unacknowledged items again. Items wait for the ones before them,
// and a "closed" callback can take up to callbackRequestTimeout (longer than
// the lease), so an item could be processed by two instances: a second
// "closed" callback, or one after another instance saved the document. So an
// item is started only while its claim is still held, and its lease is renewed
// while it is processed.
const EXPIRED_LEASE_RENEW_INTERVAL_MS = POP_EXPIRED_LEASE_MS / 3;

function wasDocumentClosed(editorData, ctx, docId) {
  const check = editorData._wasDocumentClosed;
  return typeof check === 'function' ? check.call(editorData, ctx, docId) : undefined;
}

function renewExpired(editorData, item) {
  const renew = editorData._renewDocumentPresenceExpired;
  return typeof renew === 'function' ? renew.call(editorData, item) : undefined;
}

async function processDocumentExpireItem(ctx, expiredKey, state, queue) {
  const tenant = expiredKey[0];
  const docId = expiredKey[1];

  if ((await renewExpired(docsCoServer.editorData, expiredKey)) === false) {
    return {skipped: true, startSaveCount: 0, removedCount: 0};
  }
  const renewTimer = setInterval(() => {
    Promise.resolve(renewExpired(docsCoServer.editorData, expiredKey)).then(
      held => {
        if (held === false) {
          ctx.logger.warn('checkDocumentExpire lost the claim while processing: tenant=%s docId=%s', tenant, docId);
        }
      },
      error => ctx.logger.warn('checkDocumentExpire claim renewal failed: tenant=%s docId=%s: %s', tenant, docId, error?.stack || error)
    );
  }, EXPIRED_LEASE_RENEW_INTERVAL_MS);
  renewTimer.unref?.();
  let counts;
  try {
    counts = await processClaimedDocument(ctx, tenant, docId, state, queue);
  } finally {
    clearInterval(renewTimer);
  }

  const acknowledged = await acknowledgeExpired(docsCoServer.editorData, '_ackDocumentPresenceExpired', expiredKey);
  return {acknowledged, ...counts};
}

async function processClaimedDocument(ctx, tenant, docId, state, queue) {
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
    } else if ((await wasDocumentClosed(docsCoServer.editorData, ctx, docId)) === true) {
      // The document's last exit already sent the "closed" status and cleaned
      // up; only its documents index update failed. Clean up again (a no-op
      // then), without sending the status a second time.
      await docsCoServer.cleanDocumentOnExitNoChangesPromise(ctx, docId, undefined, undefined, false, false, {sent: true});
      removedCount++;
    } else {
      await docsCoServer.cleanDocumentOnExitNoChangesPromise(ctx, docId);
      removedCount++;
    }
  }
  return {startSaveCount, removedCount};
}

async function processDocumentExpireItems(ctx, expiredKeys, state, queue) {
  let removedCount = 0;
  let startSaveCount = 0;

  for (let index = 0; index < expiredKeys.length; ++index) {
    const expiredKey = expiredKeys[index];
    const tenant = expiredKey[0];
    const docId = expiredKey[1];
    try {
      const result = await processDocumentExpireItem(ctx, expiredKey, state, queue);
      startSaveCount += result.startSaveCount;
      removedCount += result.removedCount;
      if (result.skipped) {
        ctx.logger.info('checkDocumentExpire item skipped, another instance claimed it: tenant=%s docId=%s', tenant, docId);
      } else if (result.acknowledged === false) {
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
      const filesCronStep = cronStepMs(currentFilesCron, 'services.CoAuthoring.expire.filesCron', expFilesStep);
      if (filesCronStep.message) {
        ctx.logger.error('checkFileExpire configuration error: %s', filesCronStep.message);
      }
      currentExpFilesStep = filesCronStep.stepMs;

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
            ctx.logger.error('checkFileExpire file error:', error);
            // Continue processing other files
          }
        }
        removedCount += currentRemovedCount;
      } while (currentRemovedCount > 0);
      ctx.initDefault();
      ctx.logger.info('checkFileExpire end: removedCount = %d', removedCount);
    } catch (e) {
      ctx.logger.error('checkFileExpire error:', e);
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
      // Load the runtime (AdminPanel) config first, as getCfg returns the
      // startup value until then.
      yield ctx.initTenantCache();
      const currentDocumentsCron = ctx.getCfg('services.CoAuthoring.expire.documentsCron', cfgExpDocumentsCron);
      const currentDocumentExpiryConfig = resolveDocumentExpiryStep(
        {
          documentsCron: currentDocumentsCron,
          presence: ctx.getCfg('services.CoAuthoring.expire.presence', cfgExpPresence),
          shard: ctx.getCfg('services.CoAuthoring.expire.shard', cfgExpShard)
        },
        undefined,
        {checkTtls: checkExpiryTtls}
      );
      if (!currentDocumentExpiryConfig.valid) {
        ctx.logger.error('checkDocumentExpire configuration error: %s', currentDocumentExpiryConfig.message);
        return;
      }
      if (currentDocumentExpiryConfig.clamped) {
        ctx.logger.error('checkDocumentExpire configuration error: %s', currentDocumentExpiryConfig.message);
      }
      currentExpDocumentsStep = currentDocumentExpiryConfig.stepMs;
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
      ctx.logger.error('checkDocumentExpire error:', e);
    } finally {
      try {
        if (queue) {
          yield queue.close();
        }
      } catch (e) {
        ctx.logger.error('checkDocumentExpire error:', e);
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
      ctx.logger.error('forceSaveTimeout error:', e);
    } finally {
      try {
        if (queue) {
          yield queue.close();
        }
        if (pubsub) {
          yield pubsub.close();
        }
      } catch (e) {
        ctx.logger.error('forceSaveTimeout cleanup error:', e);
      }
      // Keep force-save expiration on the same bounded continuation policy as
      // document presence expiration. This is important when auto-save keeps
      // producing timers faster than one 96-item pass can process them.
      setTimeout(forceSaveTimeout, drainRequested ? 0 : ms(currentForceSaveStep));
    }
  });
};

exports.startGC = function () {
  if (baseDocumentExpiryConfig.clamped) {
    operationContext.global.logger.error('GC configuration error: %s', baseDocumentExpiryConfig.message);
  }
  if (baseFilesCronStep.message) {
    operationContext.global.logger.error('GC configuration error: %s', baseFilesCronStep.message);
  }
  //runtime config is read on start
  setTimeout(checkDocumentExpire, expDocumentsStep);
  setTimeout(checkFileExpire, expFilesStep);
  setTimeout(forceSaveTimeout, ms(cfgForceSaveStep));
};
exports.getCronStep = getCronStep;
// The presence/statistics refresh interval in DocsCoServer must stay within the
// TTLs too, so it uses the same (possibly shortened) interval.
exports.getDocumentsExpireStep = () => expDocumentsStep;
exports.checkFileExpire = checkFileExpire;
exports.checkDocumentExpire = checkDocumentExpire;
exports.forceSaveTimeout = forceSaveTimeout;
