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
const crypto = require('crypto');
const pathModule = require('path');
const urlModule = require('url');
const {pipeline} = require('node:stream/promises');
const co = require('co');
const ms = require('ms');
const retry = require('retry');
const MultiRange = require('multi-integer-range').MultiRange;
const sqlBase = require('./databaseConnectors/baseConnector');
const utilsDocService = require('./utilsDocService');
const docsCoServer = require('./DocsCoServer');
const taskResult = require('./taskresult');
const wopiUtils = require('./wopiUtils');
const wopiClient = require('./wopiClient');
const utils = require('./../../Common/sources/utils');
const {consumeSavedState} = require('./savedState');
const constants = require('./../../Common/sources/constants');
const commonDefines = require('./../../Common/sources/commondefines');
const storage = require('./../../Common/sources/storage/storage-base');
const formatChecker = require('./../../Common/sources/formatchecker');
const statsDClient = require('./../../Common/sources/statsdclient');
const operationContext = require('./../../Common/sources/operationContext');
const tenantManager = require('./../../Common/sources/tenantManager');
const config = require('config');

const cfgTypesUpload = config.get('services.CoAuthoring.utils.limits_image_types_upload');
const cfgDocumentTypesUpload = config.get('services.CoAuthoring.utils.limits_document_types_upload');
const cfgImageSize = config.get('services.CoAuthoring.server.limits_image_size');
const cfgImageDownloadTimeout = config.get('services.CoAuthoring.server.limits_image_download_timeout');
const cfgRedisPrefix = config.get('services.CoAuthoring.redis.prefix');
const cfgTokenEnableBrowser = config.get('services.CoAuthoring.token.enable.browser');
const cfgTokenSessionAlgorithm = config.get('services.CoAuthoring.token.session.algorithm');
const cfgTokenSessionExpires = config.get('services.CoAuthoring.token.session.expires');
const cfgForgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
const cfgForgottenFilesName = config.get('services.CoAuthoring.server.forgottenfilesname');
const cfgOpenProtectedFile = config.get('services.CoAuthoring.server.openProtectedFile');
const cfgExpUpdateVersionStatus = config.get('services.CoAuthoring.expire.updateVersionStatus');
const cfgCallbackRequestTimeout = config.get('services.CoAuthoring.server.callbackRequestTimeout');
const cfgCallbackBackoffOptions = config.get('services.CoAuthoring.callbackBackoffOptions');
const cfgAssemblyFormatAsOrigin = config.get('services.CoAuthoring.server.assemblyFormatAsOrigin');
const cfgDownloadMaxBytes = config.get('FileConverter.converter.maxDownloadBytes');
const cfgDownloadTimeout = config.get('FileConverter.converter.downloadTimeout');
const cfgDownloadFileAllowExt = config.get('services.CoAuthoring.server.downloadFileAllowExt');
const cfgNewFileTemplate = config.get('services.CoAuthoring.server.newFileTemplate');

const SAVE_TYPE_PART_START = 0;
const SAVE_TYPE_COMPLETE = 2;
const SAVE_TYPE_COMPLETE_ALL = 3;

const clientStatsD = statsDClient.getClient();
const redisKeyShutdown = cfgRedisPrefix + constants.REDIS_KEY_SHUTDOWN;
let hasPasswordCol = false; //stub on upgradev630.sql update failure
exports.hasAdditionalCol = false; //stub on upgradev710.sql update failure

function OutputDataWrap(type, data) {
  this['type'] = type;
  this['data'] = data;
}
OutputDataWrap.prototype = {
  fromObject(data) {
    this['type'] = data['type'];
    this['data'] = new OutputData();
    this['data'].fromObject(data['data']);
  },
  getType() {
    return this['type'];
  },
  setType(data) {
    this['type'] = data;
  },
  getData() {
    return this['data'];
  },
  setData(data) {
    this['data'] = data;
  }
};
function OutputData(type) {
  this['type'] = type;
  this['status'] = undefined;
  this['data'] = undefined;
  this['filetype'] = undefined;
  this['openedAt'] = undefined;
}
OutputData.prototype = {
  fromObject(data) {
    this['type'] = data['type'];
    this['status'] = data['status'];
    this['data'] = data['data'];
    this['filetype'] = data['filetype'];
    this['openedAt'] = data['openedAt'];
  },
  getType() {
    return this['type'];
  },
  setType(data) {
    this['type'] = data;
  },
  getStatus() {
    return this['status'];
  },
  setStatus(data) {
    this['status'] = data;
  },
  getData() {
    return this['data'];
  },
  setData(data) {
    this['data'] = data;
  },
  getExtName() {
    return this['filetype'];
  },
  setExtName(data) {
    this['filetype'] = data.substring(1);
  },
  getOpenedAt() {
    return this['openedAt'];
  },
  setOpenedAt(data) {
    this['openedAt'] = data;
  }
};

function getOpenedAt(row) {
  if (row) {
    return sqlBase.DocumentAdditional.prototype.getOpenedAt(row.additional);
  }
}
function getOpenedAtJSONParams(row) {
  const documentLayout = row && sqlBase.DocumentAdditional.prototype.getDocumentLayout(row.additional);
  if (documentLayout) {
    return {documentLayout};
  }
  return undefined;
}

async function getOutputData(ctx, cmd, outputData, key, optConn, optAdditionalOutput, opt_bIsRestore) {
  const tenExpUpdateVersionStatus = ms(ctx.getCfg('services.CoAuthoring.expire.updateVersionStatus', cfgExpUpdateVersionStatus));

  let status, statusInfo, password, creationDate, openedAt, originFormat, row;
  const selectRes = await taskResult.select(ctx, key);
  if (selectRes.length > 0) {
    row = selectRes[0];
    status = row.status;
    statusInfo = row.status_info;
    password = sqlBase.DocumentPassword.prototype.getCurPassword(ctx, row.password);
    creationDate = row.created_at && row.created_at.getTime();
    openedAt = getOpenedAt(row);
    originFormat = row.change_id;
    if (optAdditionalOutput) {
      optAdditionalOutput.row = row;
    }
  }
  switch (status) {
    case commonDefines.FileStatus.SaveVersion:
    case commonDefines.FileStatus.UpdateVersion:
    case commonDefines.FileStatus.Ok: {
      if (commonDefines.FileStatus.Ok === status) {
        outputData.setStatus('ok');
      } else if (optConn && optConn.isCloseCoAuthoring) {
        outputData.setStatus(constants.FILE_STATUS_UPDATE_VERSION);
      } else if (optConn && optConn.user.view) {
        outputData.setStatus('ok');
      } else if (
        commonDefines.FileStatus.SaveVersion === status ||
        // A pending final-save status is taken over only by the editor auth
        // path once it expires (isUpdateVersionExpired), which also resumes or
        // reloads the save's session.
        (!opt_bIsRestore &&
          commonDefines.FileStatus.UpdateVersion === status &&
          !commonDefines.isFinalSavePendingStatusInfo(statusInfo) &&
          isUpdateVersionExpired(ctx, row, tenExpUpdateVersionStatus))
      ) {
        if (commonDefines.FileStatus.UpdateVersion === status) {
          ctx.logger.warn('UpdateVersion expired');
        }
        const updateMask = new taskResult.TaskResultData();
        updateMask.tenant = ctx.tenant;
        updateMask.key = key;
        updateMask.status = status;
        updateMask.statusInfo = statusInfo;
        const updateTask = new taskResult.TaskResultData();
        updateTask.status = commonDefines.FileStatus.Ok;
        updateTask.statusInfo = constants.NO_ERROR;
        const updateIfRes = await taskResult.updateIf(ctx, updateTask, updateMask);
        if (updateIfRes.affectedRows > 0) {
          outputData.setStatus('ok');
        } else {
          outputData.setStatus(constants.FILE_STATUS_UPDATE_VERSION);
        }
      } else {
        outputData.setStatus(constants.FILE_STATUS_UPDATE_VERSION);
      }
      const command = cmd.getCommand();
      if ('open' != command && 'reopen' != command && !cmd.getOutputUrls()) {
        const strPath = key + '/' + cmd.getOutputPath();
        if (optConn) {
          let url;
          if (cmd.getInline()) {
            url = await getPrintFileUrl(ctx, key, optConn.baseUrl, cmd.getTitle());
          } else {
            url = await storage.getSignedUrl(ctx, optConn.baseUrl, strPath, commonDefines.c_oAscUrlTypes.Temporary, cmd.getTitle());
          }
          outputData.setData(url);
          outputData.setExtName(pathModule.extname(strPath));
        } else if (optAdditionalOutput) {
          optAdditionalOutput.needUrlKey = cmd.getInline() ? key : strPath;
          optAdditionalOutput.needUrlMethod = 2;
          optAdditionalOutput.needUrlType = commonDefines.c_oAscUrlTypes.Temporary;
        }
      } else {
        const encryptedUserPassword = cmd.getPassword();
        let userPassword;
        let decryptedPassword;
        let isCorrectPassword;
        if (password && encryptedUserPassword) {
          decryptedPassword = await utils.decryptPassword(ctx, password);
          userPassword = await utils.decryptPassword(ctx, encryptedUserPassword);
          isCorrectPassword = decryptedPassword === userPassword;
        }
        let isNeedPassword = password && !isCorrectPassword;
        if (isNeedPassword && formatChecker.isBrowserEditorFormat(originFormat)) {
          //check pdf form
          //todo check without storage
          const formEditor = await storage.listObjects(ctx, key + '/Editor.bin');
          isNeedPassword = 0 !== formEditor.length;
        }
        if (isNeedPassword) {
          ctx.logger.debug('getOutputData password mismatch');
          if (encryptedUserPassword) {
            outputData.setStatus('needpassword');
            outputData.setData(constants.CONVERT_PASSWORD);
          } else {
            outputData.setStatus('needpassword');
            outputData.setData(constants.CONVERT_DRM);
          }
        } else if (optConn) {
          outputData.setOpenedAt(openedAt);
          outputData.setData(await storage.getSignedUrls(ctx, optConn.baseUrl, key, commonDefines.c_oAscUrlTypes.Session, creationDate));
          if (Object.keys(outputData.getData()).length === 0) {
            ctx.logger.warn('getOutputData empty storage');
            const updateMask = new taskResult.TaskResultData();
            updateMask.tenant = ctx.tenant;
            updateMask.key = key;
            updateMask.status = status;
            updateMask.statusInfo = statusInfo;
            const updateTask = new taskResult.TaskResultData();
            updateTask.status = commonDefines.FileStatus.None;
            updateTask.statusInfo = constants.NO_ERROR;
            const updateIfRes = await taskResult.updateIf(ctx, updateTask, updateMask);
            if (updateIfRes.affectedRows > 0) {
              status = commonDefines.FileStatus.None;
              outputData.setStatus(undefined);
            }
          }
        } else if (optAdditionalOutput) {
          optAdditionalOutput.needUrlKey = key;
          optAdditionalOutput.needUrlMethod = 0;
          optAdditionalOutput.needUrlType = commonDefines.c_oAscUrlTypes.Session;
          optAdditionalOutput.needUrlIsCorrectPassword = isCorrectPassword;
          optAdditionalOutput.creationDate = creationDate;
          optAdditionalOutput.openedAt = openedAt;
        }
      }
      break;
    }
    case commonDefines.FileStatus.NeedParams: {
      outputData.setStatus('needparams');
      const settingsPath = key + '/' + 'origin.' + cmd.getFormat();
      if (optConn) {
        const url = await storage.getSignedUrl(ctx, optConn.baseUrl, settingsPath, commonDefines.c_oAscUrlTypes.Temporary);
        outputData.setData(url);
      } else if (optAdditionalOutput) {
        optAdditionalOutput.needUrlKey = settingsPath;
        optAdditionalOutput.needUrlMethod = 1;
        optAdditionalOutput.needUrlType = commonDefines.c_oAscUrlTypes.Temporary;
      }
      break;
    }
    case commonDefines.FileStatus.NeedPassword:
      outputData.setStatus('needpassword');
      outputData.setData(statusInfo);
      break;
    case commonDefines.FileStatus.Err:
      outputData.setStatus('err');
      outputData.setData(statusInfo);
      break;
    case commonDefines.FileStatus.ErrToReload:
      outputData.setStatus('err');
      outputData.setData(statusInfo);
      await cleanupErrToReload(ctx, key);
      break;
    case commonDefines.FileStatus.None:
      //this status has no handler
      break;
    case commonDefines.FileStatus.WaitQueue:
      {
        const timeout = await utils.getConvertionTimeout(ctx);
        console.log(timeout);
        console.log(statusInfo);
        console.log(Date.now() - statusInfo * 60000);
        console.log(Date.now() - statusInfo * 60000 > timeout);
        if (Date.now() - statusInfo * 60000 > timeout) {
          ctx.logger.warn('WaitQueue expired');
          const updateMask = new taskResult.TaskResultData();
          updateMask.tenant = ctx.tenant;
          updateMask.key = key;
          updateMask.status = status;
          updateMask.statusInfo = statusInfo;
          const updateTask = new taskResult.TaskResultData();
          updateTask.status = commonDefines.FileStatus.None;
          updateTask.statusInfo = constants.NO_ERROR;
          const updateIfRes = await taskResult.updateIf(ctx, updateTask, updateMask);
          if (updateIfRes.affectedRows > 0) {
            status = commonDefines.FileStatus.None;
          }
        }
      }
      //task in the queue. response will be after convertion
      break;
    default:
      outputData.setStatus('err');
      outputData.setData(constants.UNKNOWN);
      break;
  }
  return status;
}
function* addRandomKeyTaskCmd(ctx, cmd) {
  const docId = cmd.getDocId();
  const task = yield* taskResult.addRandomKeyTask(ctx, docId);
  //set saveKey as postfix to fix vulnerability with path traversal to docId or other files
  cmd.setSaveKey(task.key.substring(docId.length));
}
function addPasswordToCmd(ctx, cmd, docPasswordStr, originFormat) {
  const docPassword = sqlBase.DocumentPassword.prototype.getDocPassword(ctx, docPasswordStr);
  if (docPassword.current) {
    if (formatChecker.isBrowserEditorFormat(originFormat)) {
      //todo not allowed different password
      cmd.setPassword(docPassword.current);
    }
    cmd.setSavePassword(docPassword.current);
  }
  if (docPassword.change) {
    cmd.setExternalChangeInfo(docPassword.change);
  }
}
function addOriginFormat(ctx, cmd, row) {
  cmd.setOriginFormat(row && row.change_id);
}

function changeFormatByOrigin(ctx, row, format) {
  const tenAssemblyFormatAsOrigin = ctx.getCfg('services.CoAuthoring.server.assemblyFormatAsOrigin', cfgAssemblyFormatAsOrigin);

  const originFormat = row && row.change_id;
  if (originFormat && constants.AVS_OFFICESTUDIO_FILE_UNKNOWN !== originFormat) {
    if (tenAssemblyFormatAsOrigin) {
      format = originFormat;
    } else {
      //for wopi always save origin
      const userAuthStr = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback);
      const wopiParams = wopiClient.parseWopiCallback(ctx, userAuthStr, row.callback);
      if (wopiParams) {
        format = originFormat;
      }
    }
  }
  return format;
}
function* saveParts(ctx, cmd, filename) {
  let result = false;
  const saveType = cmd.getSaveType();
  if (SAVE_TYPE_COMPLETE_ALL !== saveType) {
    const ext = pathModule.extname(filename);
    const saveIndex = parseInt(cmd.getSaveIndex()) || 1; //prevent path traversal
    filename = pathModule.basename(filename, ext) + saveIndex + ext;
  }
  if ((SAVE_TYPE_PART_START === saveType || SAVE_TYPE_COMPLETE_ALL === saveType) && !cmd.getSaveKey()) {
    yield* addRandomKeyTaskCmd(ctx, cmd);
  }
  if (cmd.getUrl()) {
    result = true;
  } else if (cmd.getData() && cmd.getData().length > 0 && cmd.getSaveKey()) {
    const buffer = cmd.getData();
    yield storage.putObject(ctx, cmd.getDocId() + cmd.getSaveKey() + '/' + filename, buffer, buffer.length);
    //delete data to prevent serialize into json
    cmd.data = null;
    result = SAVE_TYPE_COMPLETE_ALL === saveType || SAVE_TYPE_COMPLETE === saveType;
  } else {
    result = true;
  }
  return result;
}
function getSaveTask(ctx, cmd) {
  cmd.setData(null);
  const queueData = new commonDefines.TaskQueueData();
  queueData.setCtx(ctx);
  queueData.setCmd(cmd);
  queueData.setToFile(constants.OUTPUT_NAME + '.' + formatChecker.getStringFromFormat(cmd.getOutputFormat()));
  //todo paid
  //if (cmd.vkey) {
  //  bool
  //  bPaid;
  //  Signature.getVKeyParams(cmd.vkey, out bPaid);
  //  oTaskQueueData.m_bPaid = bPaid;
  //}
  return queueData;
}
async function getUpdateResponse(ctx, cmd) {
  const tenOpenProtectedFile = ctx.getCfg('services.CoAuthoring.server.openProtectedFile', cfgOpenProtectedFile);

  const updateTask = new taskResult.TaskResultData();
  updateTask.tenant = ctx.tenant;
  updateTask.key = cmd.getDocId();
  if (cmd.getSaveKey()) {
    updateTask.key += cmd.getSaveKey();
  }
  const statusInfo = cmd.getStatusInfo();
  if (constants.NO_ERROR === statusInfo) {
    updateTask.status = commonDefines.FileStatus.Ok;
    const password = cmd.getPassword();
    if (password) {
      if (false === hasPasswordCol) {
        const selectRes = await taskResult.select(ctx, updateTask.key);
        hasPasswordCol = selectRes.length > 0 && undefined !== selectRes[0].password;
      }
      if (hasPasswordCol) {
        updateTask.password = password;
      }
    }
  } else if (constants.CONVERT_TEMPORARY === statusInfo) {
    updateTask.status = commonDefines.FileStatus.ErrToReload;
  } else if (constants.CONVERT_DOWNLOAD === statusInfo) {
    updateTask.status = commonDefines.FileStatus.ErrToReload;
  } else if (constants.CONVERT_LIMITS === statusInfo) {
    updateTask.status = commonDefines.FileStatus.ErrToReload;
  } else if (constants.CONVERT_NEED_PARAMS === statusInfo) {
    updateTask.status = commonDefines.FileStatus.NeedParams;
  } else if (constants.CONVERT_DRM === statusInfo || constants.CONVERT_PASSWORD === statusInfo) {
    if (tenOpenProtectedFile) {
      updateTask.status = commonDefines.FileStatus.NeedPassword;
    } else {
      updateTask.status = commonDefines.FileStatus.Err;
    }
  } else if (constants.CONVERT_DRM_UNSUPPORTED === statusInfo) {
    updateTask.status = commonDefines.FileStatus.Err;
  } else if (constants.CONVERT_DEAD_LETTER === statusInfo) {
    updateTask.status = commonDefines.FileStatus.ErrToReload;
  } else {
    updateTask.status = commonDefines.FileStatus.Err;
  }
  updateTask.statusInfo = statusInfo;
  return updateTask;
}
function taskResultMatchesMask(row, mask) {
  // Repeat the ownership check that the conditional SQL uses. Cleanup can take
  // several attempts, so a fresh read must prove that this attempt still owns
  // the row before it touches the cache.
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
function hasSameFinalSaveOwner(row, mask) {
  return (
    taskResultMatchesMask(row, {...mask, additional: null}) &&
    JSON.stringify(readFinalSaveMarkers(row.additional).at(-1)) === JSON.stringify(readFinalSaveMarkers(mask.additional).at(-1))
  );
}
function* retryChangedFinalSaveMetadata(ctx, docId, mask) {
  const currentRes = yield taskResult.select(ctx, docId);
  if (hasSameFinalSaveOwner(currentRes[0], mask)) {
    // A failed snapshot comparison is not proof of completion or takeover.
    // Retrying reads the new metadata and still compares it atomically in SQL.
    throw new Error('final-save metadata changed; retry with current ownership snapshot');
  }
}
function getCleanupClaimStatusInfo(mask) {
  // A cleanup claim needs a value that is stable across retries, but cannot be
  // mistaken for a normal status timestamp.  Deriving a pending value from
  // the status the cleanup expects lets a retry of the same cleanup recognize
  // its own claim.
  const value = [mask.tenant, mask.key, mask.status, mask.statusInfo].map(item => String(item ?? '')).join('|');
  let hash = 2166136261;
  for (let i = 0; i < value.length; ++i) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 3 + ((hash >>> 0) % 100000000);
}
function isCallbackAcceptedStatusInfo(statusInfo) {
  return statusInfo === commonDefines.CALLBACK_ACCEPTED_STATUS_INFO || statusInfo === commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO;
}
// Final-save state on the task row.
//
// Every write by which a final save takes or changes the row appends a marker
// to task_result.additional in the same UPDATE: phase 'sending' (or 'declined'
// for a declined save's retry) when an attempt moves the row to UpdateVersion,
// 'accepted' together with the accepted status, 'declined' together with the
// restored SaveVersion.  The SQL appends `additional`, so the last marker names
// the save that wrote the row's current status; every attempt and redelivery
// checks ownership against it rather than against anything it carries itself.
// `since` dates the phase (last_open_date cannot: every open refreshes it).
// Databases without the `additional` column (failed upgradev710) get no
// markers and fall back to the status a retry wrote (sfcStatusInfo).
const FINAL_SAVE_MARKER = 'sfcFinalSave';
// The same test as the auth path (exports.hasAdditionalCol): a row read with
// SELECT * carries `additional` unless the column is missing.
function hasAdditionalColumn(row) {
  return !row || undefined !== row.additional;
}
// The marker in one `additional` entry, or undefined.  Malformed entries are
// not markers.
function parseFinalSaveMarker(entry) {
  try {
    const marker = JSON.parse(entry)?.[FINAL_SAVE_MARKER];
    return marker && marker.operationId !== undefined ? marker : undefined;
  } catch (_e) {
    return undefined;
  }
}
function readFinalSaveMarkers(additional) {
  // Parse entry by entry so that a malformed entry cannot hide a marker.
  const markers = [];
  if (additional) {
    for (const entry of additional.split(constants.CHAR_DELIMITER).slice(1)) {
      const marker = parseFinalSaveMarker(entry);
      if (marker) {
        markers.push(marker);
      }
    }
  }
  return markers;
}
// Markers are only needed while a save or a stale delivery of it can still
// arrive.  A row whose key is reused collects one per final save, so once it
// holds MAX_FINAL_SAVE_MARKERS, the next write keeps the newest
// KEPT_FINAL_SAVE_MARKERS and rewrites the column instead of appending.
const MAX_FINAL_SAVE_MARKERS = 20;
const KEPT_FINAL_SAVE_MARKERS = 10;
// A pruning rewrite must start from the column as it is now, not as read
// before the callback: entries appended meanwhile (another delivery's marker,
// a shardKey) would be lost.
function* getAdditionalForMarker(ctx, docId, currentAdditional) {
  if (readFinalSaveMarkers(currentAdditional).length < MAX_FINAL_SAVE_MARKERS) {
    return currentAdditional;
  }
  const selectRes = yield taskResult.select(ctx, docId);
  return selectRes.length > 0 ? selectRes[0].additional : currentAdditional;
}
// Sets task.additional (and task.replaceAdditional) to record a new marker on
// a row whose `additional` currently is `currentAdditional`.  Returns the
// resulting value of the column.
function setFinalSaveMarker(task, currentAdditional, operationId, phase, openFromForgotten) {
  const data = new sqlBase.DocumentAdditional();
  data.data.push({[FINAL_SAVE_MARKER]: {operationId: String(operationId), phase, openFromForgotten: openFromForgotten === true, since: Date.now()}});
  const entry = data.toSQLInsert();
  const markers = readFinalSaveMarkers(currentAdditional).length;
  if (markers < MAX_FINAL_SAVE_MARKERS) {
    // Only the new entry: the SQL appends.
    task.additional = entry;
    return (currentAdditional || '') + entry;
  }
  let toSkip = markers - (KEPT_FINAL_SAVE_MARKERS - 1);
  const kept = (currentAdditional || '')
    .split(constants.CHAR_DELIMITER)
    .slice(1)
    .filter(item => !(parseFinalSaveMarker(item) && toSkip-- > 0));
  task.additional = kept.map(item => constants.CHAR_DELIMITER + item).join('') + entry;
  task.replaceAdditional = true;
  return task.additional;
}
// What the row says about the final save `operationId`:
// - own: its last marker (accepted or declined), even after later saves;
// - pendingOwn: the row holds this save's accepted status (its own cleanup
//   claim is recognized by its value, getOwnCleanupClaimStatusInfo).
function getFinalSaveState(row, operationId) {
  const markers = row ? readFinalSaveMarkers(row.additional) : [];
  const id = String(operationId);
  let own;
  for (let i = markers.length - 1; i >= 0 && !own; --i) {
    if (markers[i].operationId === id) {
      own = markers[i];
    }
  }
  const last = markers.at(-1);
  const pendingOwn =
    !!row &&
    commonDefines.FileStatus.UpdateVersion === row.status &&
    last?.operationId === id &&
    'accepted' === last.phase &&
    isCallbackAcceptedStatusInfo(row.status_info);
  return {own, last, pendingOwn};
}
// The longest a live final save keeps a pending status: its whole
// infrastructure retry budget, as an upper bound (a randomized delay is at
// most twice its base), so that every open computes the same expiry.
function getSfcRetryWindow(ctx) {
  const options = ctx.getCfg('services.CoAuthoring.callbackBackoffOptions', cfgCallbackBackoffOptions);
  const timeout = {...options.timeout, randomize: false};
  let window = 0;
  for (let i = 0; i < options.infraRetries; ++i) {
    window += retry.createTimeout(Math.min(i, SFC_RETRY_DELAY_STEPS), timeout);
  }
  return options.timeout?.randomize ? 2 * window : window;
}
// Until when the callback of a final save may still be in flight on an
// UpdateVersion row whose last marker is that save's 'sending' one: the whole
// callback (or WOPI PutFile) timeout after the marker.  0 otherwise.
function getCallbackInFlightUntil(ctx, row) {
  const marker = readFinalSaveMarkers(row.additional).at(-1);
  if ('sending' !== marker?.phase || !Number.isFinite(marker.since)) {
    return 0;
  }
  const wholeCycle = ctx.getCfg('services.CoAuthoring.server.callbackRequestTimeout', cfgCallbackRequestTimeout)?.wholeCycle;
  const timeout = 'number' === typeof wholeCycle ? wholeCycle : ms(String(wholeCycle ?? 0));
  return marker.since + (Number.isFinite(timeout) ? timeout : 0);
}
// Whether an open may take over an UpdateVersion row (DocsCoServer auth path).
// A minute timestamp expires after expire.updateVersionStatus, and no sooner
// after the end of a callback that may still be in flight
// (getCallbackInFlightUntil): its acceptance could no longer be recorded, and
// editors who joined meanwhile would never get updateVersion.  A pending
// status expires that long after the retry window of the save that set it:
// by then the save was abandoned or its retry was lost.  A pending status
// without a dated marker (a WOPI cache invalidation's claim, or a database
// without the `additional` column) expires at once: last_open_date cannot
// date it, every open refreshes it, and the takeover keeps whatever that save
// left (takeOverAbandonedSave).  So does a takeover's hold: it lasts only
// while the takeover decides, and one that is still there was interrupted.
function isUpdateVersionExpired(ctx, row, expireMs) {
  if (!commonDefines.isFinalSavePendingStatusInfo(row.status_info)) {
    const now = Date.now();
    return now - row.status_info * 60000 > expireMs && now - getCallbackInFlightUntil(ctx, row) > expireMs;
  }
  if (commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO === row.status_info) {
    return true;
  }
  // Only the marker of the save that set the pending status dates it: an
  // accepted status by its acceptance, a cleanup claim by its decline.  A claim
  // after any other marker is a WOPI cache invalidation's.
  const marker = readFinalSaveMarkers(row.additional).at(-1);
  const dated = marker && (isCallbackAcceptedStatusInfo(row.status_info) ? 'accepted' === marker.phase : 'declined' === marker.phase);
  const since = dated ? marker.since : undefined;
  return !Number.isFinite(since) || Date.now() - since > expireMs + getSfcRetryWindow(ctx);
}
// Whether a final save (or its cleanup, or an open taking its row over) may
// still act on an UpdateVersion row: a pending status, expired or not (only
// the auth path takes those over), or a callback that may still be in flight.
// Nothing else may clean the row up meanwhile (wopiClient cache check).
function isFinalSaveInProgress(ctx, row) {
  if (commonDefines.isFinalSavePendingStatusInfo(row.status_info)) {
    return true;
  }
  const expireMs = ms(ctx.getCfg('services.CoAuthoring.expire.updateVersionStatus', cfgExpUpdateVersionStatus));
  return getCallbackInFlightUntil(ctx, row) > 0 && !isUpdateVersionExpired(ctx, row, expireMs);
}
function* retryTakeoverMetadata(ctx, mask, action) {
  // Bound optimistic retries under a busy metadata writer. Every attempt
  // still compares the refreshed snapshot atomically in SQL.
  for (let attempt = 0; attempt < 3; ++attempt) {
    if (yield action()) {
      return true;
    }
    const currentRes = yield taskResult.select(ctx, mask.key);
    const current = currentRes[0];
    if (!hasSameFinalSaveOwner(current, mask) || (current.additional || null) === mask.additional) {
      return false;
    }
    mask.additional = current.additional || null;
  }
  return false;
}
// Takes over a row that an abandoned final save still holds (a pending
// status_info), for an open or for the save itself when it gives up.  What is
// left of the save decides, not what the integrator may have done with the
// file:
// - its changes are still there: its cleanup never deleted them, so the
//   session is resumed from the cache with them (resumeTask).  Nothing is lost
//   and nothing is applied twice.
// - its changes are gone: its cleanup ran, so the integrator has the file (an
//   accepted save) or the forgotten file has it (a cleanup claim), and the
//   document is opened from there (reloadTask).  An accepted save's forgotten
//   file is obsolete then, as after a completed save.
// The row is held first (FINAL_SAVE_TAKEOVER_STATUS_INFO, which keeps opens
// out and which no save owns): from then on a slow attempt of the save can no
// longer delete the changes (every deletion of a save is conditional on its
// status, and that check locks the row, so the hold waits for a deletion in
// flight: getOwnershipCheck in baseConnector, or Oracle's deleteChangesIf),
// so they decide for good. Only then does the row let a session start
// on it.
// Returns 'resume' or 'reload', or undefined if the row changed meanwhile.
function* takeOverAbandonedSave(ctx, docId, row, resumeTask, reloadTask) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  const holdTask = newTaskMask(ctx, docId, commonDefines.FileStatus.UpdateVersion, commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO);
  const holdMask = newTaskMask(ctx, docId, row.status, row.status_info);
  holdMask.additional = row.additional || null;
  let held = yield* retryTakeoverMetadata(ctx, holdMask, async () => (await taskResult.updateIf(ctx, holdTask, holdMask)).affectedRows > 0);
  const ownedHoldMask = {...holdTask, additional: holdMask.additional};
  if (!held && commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO === row.status_info) {
    // Taking an interrupted hold over writes the values the row already has
    // (the open's upsert set last_open_date in the same second), which MySQL
    // and MariaDB report as 0 rows: they count changed rows, not matched ones.
    // Tell an unchanged hold from a row that changed meanwhile.
    const selectRes = yield taskResult.select(ctx, docId);
    held = selectRes.length > 0 && taskResultMatchesMask(selectRes[0], ownedHoldMask);
  }
  if (!held) {
    return undefined;
  }
  // Changes include a password changed in the session (hasChanges).
  const resume = yield docsCoServer.hasChanges(ctx, docId);
  // An accepted save's acceptance stays the row's last marker while the row is
  // held, so that a takeover of an interrupted hold decides the same way.
  const lastMarker = readFinalSaveMarkers(row.additional).at(-1);
  const accepted =
    isCallbackAcceptedStatusInfo(row.status_info) ||
    (commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO === row.status_info && 'accepted' === lastMarker?.phase);
  if (!resume && accepted) {
    const cleaned = yield* retryTakeoverMetadata(ctx, ownedHoldMask, () =>
      taskResult.withCleanupOwnership(ctx, ownedHoldMask, () => storage.deletePath(ctx, docId, tenForgottenFiles))
    );
    if (!cleaned) {
      return undefined;
    }
  }
  const updated = yield* retryTakeoverMetadata(
    ctx,
    ownedHoldMask,
    async () => (await taskResult.updateIf(ctx, resume ? resumeTask : reloadTask, ownedHoldMask)).affectedRows > 0
  );
  if (!updated) {
    // Another open took the hold over (it decides the same way).
    return undefined;
  }
  return resume ? 'resume' : 'reload';
}
// For an open (DocsCoServer auth path): Ok resumes from the cache, None opens
// the file again.  Returns the new status, or undefined if the row changed.
function* takeOverAbandonedSaveForOpen(ctx, docId, row) {
  const resumeTask = newTaskMask(ctx, docId, commonDefines.FileStatus.Ok, constants.NO_ERROR);
  const reloadTask = newTaskMask(ctx, docId, commonDefines.FileStatus.None, constants.NO_ERROR);
  const outcome = yield* takeOverAbandonedSave(ctx, docId, row, resumeTask, reloadTask);
  if (outcome) {
    ctx.logger.warn('UpdateVersion expired: %s', outcome);
  }
  return outcome && (outcome === 'resume' ? resumeTask.status : reloadTask.status);
}
function newTaskMask(ctx, docId, status, statusInfo) {
  const mask = new taskResult.TaskResultData();
  mask.tenant = ctx.tenant;
  mask.key = docId;
  mask.status = status;
  mask.statusInfo = statusInfo;
  return mask;
}
// The cleanup claim that the forgotten-file path of save `cmd` takes:
// cleanupCacheIf derives it from the restored SaveVersion row.
function getOwnCleanupClaimStatusInfo(ctx, docId, cmd) {
  return getCleanupClaimStatusInfo(newTaskMask(ctx, docId, commonDefines.FileStatus.SaveVersion, cmd.getStatusInfoIn()));
}
const cleanupCache = co.wrap(function* (ctx, docId) {
  //todo redis ?
  let res = false;
  const removeRes = yield taskResult.remove(ctx, docId);
  if (removeRes.affectedRows > 0) {
    yield storage.deletePath(ctx, docId);
    if (docsCoServer?.editorStatProxy?.deleteKey) {
      yield docsCoServer.editorStatProxy.deleteKey(docId);
    }
    res = true;
  }
  ctx.logger.debug('cleanupCache docId=%s db.affectedRows=%d', docId, removeRes.affectedRows);
  return res;
});
function deleteDocumentCacheIfOwned(ctx, mask) {
  return taskResult.withCleanupOwnership(ctx, mask, async () => {
    await storage.deletePath(ctx, mask.key);
    if (docsCoServer?.editorStatProxy?.deleteKey) {
      await docsCoServer.editorStatProxy.deleteKey(mask.key);
    }
  });
}
const cleanupCacheIf = co.wrap(function* (ctx, mask) {
  //todo redis ?
  // Cleanup is deliberately staged: claim the exact row, delete its changes,
  // recheck ownership, remove storage, then remove the row.  Each stage can
  // fail independently without allowing a newer save to be deleted.
  const selectRes = yield taskResult.select(ctx, mask.key);
  if (selectRes.length === 0) {
    // Cache cleanup is idempotent: a retry can arrive after the task row was
    // removed by the successful cleanup attempt.
    return true;
  }
  // Claiming converts the row to a deterministic cleanup status atomically.
  // That closes the select/delete race and lets a retry recognize its own
  // claim instead of claiming a newer save.
  const claimStatusInfo = getCleanupClaimStatusInfo(mask);
  const cleanupMask = newTaskMask(ctx, mask.key, commonDefines.FileStatus.UpdateVersion, claimStatusInfo);
  cleanupMask.additional = mask.additional;
  const alreadyClaimed = taskResultMatchesMask(selectRes[0], cleanupMask);
  if (!alreadyClaimed) {
    const claimTask = newTaskMask(ctx, mask.key, commonDefines.FileStatus.UpdateVersion, claimStatusInfo);
    const claimRes = yield taskResult.claimIf(ctx, claimTask, mask);
    if (!(claimRes.affectedRows > 0)) {
      const currentRes = yield taskResult.select(ctx, mask.key);
      // Gone: done.  Changed between the read and the claim: no longer ours.
      return currentRes.length === 0;
    }
  }
  // Delete changes under the ownership condition while retaining the task row.
  // Keeping the row here preserves the retry metadata if storage deletion
  // fails, while also preventing a stale cleanup from deleting newer data.
  yield taskResult.deleteChangesIf(ctx, cleanupMask);
  const cleaned = yield deleteDocumentCacheIfOwned(ctx, cleanupMask);
  if (cleaned) {
    const removeRes = yield taskResult.removeIf(ctx, cleanupMask);
    ctx.logger.debug('cleanupCacheIf db.affectedRows=%d', removeRes.affectedRows);
    if (removeRes.affectedRows > 0) {
      return true;
    }
  }
  // A concurrent cleanup may have removed the row after our ownership check.
  // Missing means the work is complete; a live row means this attempt lost
  // ownership and must be retried.
  const remainingRes = yield taskResult.select(ctx, mask.key);
  return remainingRes.length === 0;
});
async function cleanupErrToReload(ctx, key) {
  const updateTask = new taskResult.TaskResultData();
  updateTask.tenant = ctx.tenant;
  updateTask.key = key;
  updateTask.status = commonDefines.FileStatus.None;
  updateTask.statusInfo = constants.NO_ERROR;
  await taskResult.update(ctx, updateTask);
}

function commandOpenStartPromise(ctx, docId, baseUrl, opt_documentCallbackUrl, opt_format) {
  const task = new taskResult.TaskResultData();
  task.tenant = ctx.tenant;
  task.key = docId;
  //None instead WaitQueue to prevent: conversion task is lost when entering and leaving the editor quickly(that leads to an endless opening)
  task.status = commonDefines.FileStatus.None;
  task.statusInfo = constants.NO_ERROR;
  task.baseurl = baseUrl;
  if (opt_documentCallbackUrl) {
    task.callback = opt_documentCallbackUrl;
  }
  if (opt_format) {
    task.changeId = formatChecker.getFormatFromString(opt_format);
  }
  return taskResult.upsert(ctx, task);
}
function* commandOpen(ctx, conn, cmd, outputData, opt_upsertRes, opt_bIsRestore) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);

  let upsertRes;
  if (opt_upsertRes) {
    upsertRes = opt_upsertRes;
  } else {
    upsertRes = yield commandOpenStartPromise(ctx, cmd.getDocId(), utils.getBaseUrlByConnection(ctx, conn), undefined, cmd.getFormat());
  }
  const bCreate = upsertRes.isInsert;
  let needAddTask = bCreate;
  if (!bCreate) {
    needAddTask = yield* commandOpenFillOutput(ctx, conn, cmd, outputData, opt_bIsRestore);
  }
  if (conn.encrypted) {
    ctx.logger.debug('commandOpen encrypted %j', outputData);
    if (constants.FILE_STATUS_UPDATE_VERSION !== outputData.getStatus()) {
      //don't send output data
      outputData.setStatus(undefined);
    }
  } else if (needAddTask) {
    const updateMask = new taskResult.TaskResultData();
    updateMask.tenant = ctx.tenant;
    updateMask.key = cmd.getDocId();
    updateMask.status = commonDefines.FileStatus.None;

    const task = new taskResult.TaskResultData();
    task.status = commonDefines.FileStatus.WaitQueue;
    task.statusInfo = Math.floor(Date.now() / 60000); //minutes

    const updateIfRes = yield taskResult.updateIf(ctx, task, updateMask);
    if (updateIfRes.affectedRows > 0) {
      const forgotten = yield storage.listObjects(ctx, cmd.getDocId(), tenForgottenFiles);
      //replace url with forgotten file because it absorbed all lost changes
      if (forgotten.length > 0) {
        ctx.logger.debug('commandOpen from forgotten');
        cmd.setUrl(undefined);
        cmd.setForgotten(cmd.getDocId());
      }
      //add task
      if (!cmd.getOutputFormat()) {
        //todo remove getOpenFormatByEditor after 8.2.1
        cmd.setOutputFormat(docsCoServer.getOpenFormatByEditor(conn.editorType));
      }
      cmd.setEmbeddedFonts(false);
      const dataQueue = new commonDefines.TaskQueueData();
      dataQueue.setCtx(ctx);
      dataQueue.setCmd(cmd);
      dataQueue.setToFile('Editor.bin');
      yield* docsCoServer.addTask(dataQueue, constants.QUEUE_PRIORITY_HIGH);
    } else {
      yield* commandOpenFillOutput(ctx, conn, cmd, outputData, opt_bIsRestore);
    }
  }
}
function* commandOpenFillOutput(ctx, conn, cmd, outputData, opt_bIsRestore) {
  const status = yield getOutputData(ctx, cmd, outputData, cmd.getDocId(), conn, undefined, opt_bIsRestore);
  return commonDefines.FileStatus.None === status;
}
function* commandReopen(ctx, conn, cmd, outputData) {
  const tenOpenProtectedFile = ctx.getCfg('services.CoAuthoring.server.openProtectedFile', cfgOpenProtectedFile);

  let res = true;
  const isPassword = undefined !== cmd.getPassword();
  if (isPassword) {
    const selectRes = yield taskResult.select(ctx, cmd.getDocId());
    if (selectRes.length > 0) {
      const row = selectRes[0];
      if (sqlBase.DocumentPassword.prototype.getCurPassword(ctx, row.password)) {
        ctx.logger.debug('commandReopen has password');
        yield* commandOpenFillOutput(ctx, conn, cmd, outputData, false);
        yield docsCoServer.modifyConnectionForPassword(ctx, conn, constants.FILE_STATUS_OK === outputData.getStatus());
        return res;
      }
    }
  }
  if (!isPassword || tenOpenProtectedFile) {
    const updateMask = new taskResult.TaskResultData();
    updateMask.tenant = ctx.tenant;
    updateMask.key = cmd.getDocId();
    updateMask.status = isPassword ? commonDefines.FileStatus.NeedPassword : commonDefines.FileStatus.NeedParams;

    const task = new taskResult.TaskResultData();
    task.status = commonDefines.FileStatus.WaitQueue;
    task.statusInfo = Math.floor(Date.now() / 60000); //minutes

    const upsertRes = yield taskResult.updateIf(ctx, task, updateMask);
    if (upsertRes.affectedRows > 0) {
      //add task
      cmd.setUrl(null); //url may expire
      if (!cmd.getOutputFormat()) {
        //todo remove getOpenFormatByEditor after 8.2.1
        cmd.setOutputFormat(docsCoServer.getOpenFormatByEditor(conn.editorType));
      }
      cmd.setEmbeddedFonts(false);
      if (isPassword) {
        cmd.setUserConnectionId(conn.user.id);
      }
      const dataQueue = new commonDefines.TaskQueueData();
      dataQueue.setCtx(ctx);
      dataQueue.setCmd(cmd);
      dataQueue.setToFile('Editor.bin');
      dataQueue.setFromSettings(true);
      yield* docsCoServer.addTask(dataQueue, constants.QUEUE_PRIORITY_HIGH);
    } else {
      outputData.setStatus('needpassword');
      outputData.setData(constants.CONVERT_PASSWORD);
    }
  } else {
    res = false;
  }
  return res;
}
function* commandSave(ctx, cmd, outputData) {
  const format = cmd.getFormat() || 'bin';
  const completeParts = yield* saveParts(ctx, cmd, 'Editor.' + format);
  if (completeParts) {
    const queueData = getSaveTask(ctx, cmd);
    yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);
  }
  outputData.setStatus('ok');
  outputData.setData(cmd.getSaveKey());
}
function* commandSendMailMerge(ctx, cmd, outputData) {
  const mailMergeSend = cmd.getMailMergeSend();
  const isJson = mailMergeSend.getIsJsonKey();
  const completeParts = yield* saveParts(ctx, cmd, isJson ? 'Editor.json' : 'Editor.bin');
  let isErr = false;
  if (completeParts && !isJson) {
    isErr = true;
    const getRes = yield docsCoServer.getCallback(ctx, cmd.getDocId(), cmd.getUserIndex());
    if (getRes && !getRes.wopiParams) {
      mailMergeSend.setUrl(getRes.server.href);
      mailMergeSend.setBaseUrl(getRes.baseUrl);
      //we change JsonKey and SaveKey, a new key is needed because a part is done in one conversion, and json is always needed
      mailMergeSend.setJsonKey(cmd.getSaveKey());
      mailMergeSend.setRecordErrorCount(0);
      yield* addRandomKeyTaskCmd(ctx, cmd);
      const queueData = getSaveTask(ctx, cmd);
      yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);
      isErr = false;
    } else if (getRes.wopiParams) {
      ctx.logger.warn('commandSendMailMerge unexpected with wopi');
    }
  }
  if (isErr) {
    outputData.setStatus('err');
    outputData.setData(constants.UNKNOWN);
  } else {
    outputData.setStatus('ok');
    outputData.setData(cmd.getSaveKey());
  }
}
const commandSfctByCmd = co.wrap(function* (ctx, cmd, opt_priority, opt_expiration, opt_queue, opt_initShardKey) {
  const selectRes = yield taskResult.selectWithCache(ctx, cmd.getDocId());
  const row = selectRes.length > 0 ? selectRes[0] : null;
  if (!row) {
    return false;
  }
  if (opt_initShardKey) {
    ctx.setShardKey(sqlBase.DocumentAdditional.prototype.getShardKey(row.additional));
    ctx.setWopiSrc(sqlBase.DocumentAdditional.prototype.getWopiSrc(row.additional));
  }
  yield* addRandomKeyTaskCmd(ctx, cmd);
  addPasswordToCmd(ctx, cmd, row.password, row.change_id);
  addOriginFormat(ctx, cmd, row);
  const userAuthStr = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback);
  cmd.setWopiParams(wopiClient.parseWopiCallback(ctx, userAuthStr, row.callback));
  cmd.setOutputFormat(changeFormatByOrigin(ctx, row, cmd.getOutputFormat()));
  cmd.appendJsonParams(getOpenedAtJSONParams(row));
  const queueData = getSaveTask(ctx, cmd);
  queueData.setFromChanges(true);
  const priority = null != opt_priority ? opt_priority : constants.QUEUE_PRIORITY_LOW;
  yield* docsCoServer.addTask(queueData, priority, opt_queue, opt_expiration);
  return true;
});
function isDisplayedImage(strName) {
  let res = 0;
  if (strName) {
    //template display[N]image.ext
    const findStr = constants.DISPLAY_PREFIX;
    const index = strName.indexOf(findStr);
    if (-1 != index) {
      if (index + findStr.length < strName.length) {
        const displayN = parseInt(strName[index + findStr.length]);
        if (!isNaN(displayN)) {
          const imageIndex = index + findStr.length + 1;
          if (imageIndex == strName.indexOf('image', imageIndex)) {
            res = displayN;
          }
        }
      }
    }
  }
  return res;
}
function* commandImgurls(ctx, conn, cmd, outputData) {
  const tenTypesUpload = ctx.getCfg('services.CoAuthoring.utils.limits_image_types_upload', cfgTypesUpload);
  const tenDocumentTypesUpload = ctx.getCfg('services.CoAuthoring.utils.limits_document_types_upload', cfgDocumentTypesUpload);
  const tenImageSize = ctx.getCfg('services.CoAuthoring.server.limits_image_size', cfgImageSize);
  const tenImageDownloadTimeout = ctx.getCfg('services.CoAuthoring.server.limits_image_download_timeout', cfgImageDownloadTimeout);
  const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

  let errorCode = constants.NO_ERROR;
  let urls = cmd.getData();
  const authorizations = [];
  let isInJwtToken = false;
  const token = cmd.getTokenDownload();
  if (tenTokenEnableBrowser && token) {
    // allow requests without token
    const checkJwtRes = yield docsCoServer.checkJwt(ctx, token, commonDefines.c_oAscSecretType.Browser);
    if (checkJwtRes.decoded) {
      //todo multiple url case
      if (checkJwtRes.decoded.images) {
        urls = checkJwtRes.decoded.images.map(curValue => {
          return curValue.url;
        });
      } else {
        urls = [checkJwtRes.decoded.url];
      }
      for (let i = 0; i < urls.length; ++i) {
        if (utils.canIncludeOutboxAuthorization(ctx, urls[i])) {
          const secret = yield tenantManager.getTenantSecret(ctx, commonDefines.c_oAscSecretType.Outbox);
          authorizations[i] = [utils.fillJwtForRequest(ctx, {url: urls[i]}, secret, false)];
        }
      }
      isInJwtToken = true;
    } else {
      ctx.logger.warn('Error commandImgurls jwt: %s', checkJwtRes.description);
      errorCode = constants.VKEY_ENCRYPT;
    }
  }
  const supportedFormats = tenTypesUpload || 'jpg';
  const supportedDocumentFormats = tenDocumentTypesUpload || 'xlsx';
  const outputUrls = [];
  if (constants.NO_ERROR === errorCode && !conn.user.view && !conn.isCloseCoAuthoring) {
    //todo Promise.all()
    const displayedImageMap = {}; //to make one prefix for ole object urls
    for (let i = 0; i < urls.length; ++i) {
      const urlSource = urls[i];
      let urlParsed;
      let isDocument = false;
      let data = undefined;
      if (urlSource?.startsWith('data:')) {
        const delimiterIndex = urlSource.indexOf(',');
        if (-1 != delimiterIndex) {
          const dataLen = urlSource.length - (delimiterIndex + 1);
          if ('hex' === urlSource.substring(delimiterIndex - 3, delimiterIndex).toLowerCase()) {
            if (dataLen * 0.5 <= tenImageSize) {
              data = Buffer.from(urlSource.substring(delimiterIndex + 1), 'hex');
            } else {
              errorCode = constants.UPLOAD_CONTENT_LENGTH;
            }
          } else {
            if (dataLen * 0.75 <= tenImageSize) {
              data = Buffer.from(urlSource.substring(delimiterIndex + 1), 'base64');
            } else {
              errorCode = constants.UPLOAD_CONTENT_LENGTH;
            }
          }
        }
      } else if (urlSource) {
        try {
          if (authorizations[i]) {
            const urlParsed = urlModule.parse(urlSource);
            const filterStatus = yield* utils.checkHostFilter(ctx, urlParsed.hostname);
            if (0 !== filterStatus) {
              throw Error('checkIpFilter');
            }
          }
          //todo stream
          const getRes = yield utils.downloadUrlPromise(ctx, urlSource, tenImageDownloadTimeout, tenImageSize, authorizations[i], isInJwtToken);
          data = getRes.body;
          urlParsed = urlModule.parse(urlSource);
        } catch (e) {
          data = undefined;
          ctx.logger.error('error commandImgurls download: url = %s; %s', urlSource, e.stack);
          if (e.code === 'EMSGSIZE') {
            errorCode = constants.UPLOAD_CONTENT_LENGTH;
          } else {
            errorCode = constants.UPLOAD_URL;
          }
        }
      }

      let outputUrl = {url: 'error', path: 'error'};
      if (data) {
        // process image: fix EXIF rotation and convert unsupported formats to optimal format
        data = yield utilsDocService.processImageOptimal(ctx, data);

        const format = formatChecker.getImageFormat(ctx, data);
        let formatStr;
        let isAllow = false;
        if (constants.AVS_OFFICESTUDIO_FILE_UNKNOWN !== format) {
          formatStr = formatChecker.getStringFromFormat(format);
          if (formatStr && -1 !== supportedFormats.indexOf(formatStr)) {
            isAllow = true;
          }
        } else if (constants.AVS_OFFICESTUDIO_FILE_SPREADSHEET_XLSX === formatChecker.getOfficeZipFormatBySignature(data)) {
          formatStr = 'xlsx';
          if (-1 !== supportedDocumentFormats.indexOf(formatStr)) {
            isAllow = true;
            isDocument = true;
          }
        }
        if (!isAllow && urlParsed) {
          //for ole object, presentation video/audio
          const ext = pathModule.extname(urlParsed.pathname).substring(1);
          const urlBasename = pathModule.basename(urlParsed.pathname);
          const displayedImageName = urlBasename.substring(0, urlBasename.length - ext.length - 1);
          if (Object.hasOwn(displayedImageMap, displayedImageName)) {
            formatStr = ext;
            isAllow = true;
          }
        }
        if (isAllow) {
          let strLocalPath = 'media/' + crypto.randomBytes(16).toString('hex') + '_';
          if (urlParsed) {
            const urlBasename = pathModule.basename(urlParsed.pathname);
            const displayN = isDisplayedImage(urlBasename);
            if (displayN > 0) {
              const displayedImageName = urlBasename.substring(0, urlBasename.length - formatStr.length - 1);
              if (displayedImageMap[displayedImageName]) {
                strLocalPath = displayedImageMap[displayedImageName];
              } else {
                displayedImageMap[displayedImageName] = strLocalPath;
              }
              strLocalPath += constants.DISPLAY_PREFIX + displayN;
            }
          }
          if (isDocument) {
            strLocalPath += 'document1' + '.' + formatStr;
          } else {
            strLocalPath += 'image1' + '.' + formatStr;
          }
          const strPath = cmd.getDocId() + '/' + strLocalPath;
          yield storage.putObject(ctx, strPath, data, data.length);
          const imgUrl = yield storage.getSignedUrl(ctx, conn.baseUrl, strPath, commonDefines.c_oAscUrlTypes.Session);
          outputUrl = {url: imgUrl, path: strLocalPath};
        }
      }
      if (constants.NO_ERROR === errorCode && ('error' === outputUrl.url || 'error' === outputUrl.path)) {
        errorCode = constants.UPLOAD_EXTENSION;
      }
      outputUrls.push(outputUrl);
    }
  } else if (constants.NO_ERROR === errorCode) {
    ctx.logger.warn('error commandImgurls: access deny');
    errorCode = constants.UPLOAD;
  }
  if (constants.NO_ERROR !== errorCode && 0 == outputUrls.length) {
    outputData.setStatus('err');
    outputData.setData(errorCode);
  } else {
    outputData.setStatus('ok');
    outputData.setData({error: errorCode, urls: outputUrls});
  }
}
function* commandPathUrls(ctx, conn, data, outputData) {
  const listImages = data.map(currentValue => {
    return conn.docId + '/' + currentValue;
  });
  const urls = yield storage.getSignedUrlsArrayByArray(ctx, conn.baseUrl, listImages, commonDefines.c_oAscUrlTypes.Session);
  outputData.setStatus('ok');
  outputData.setData(urls);
}
function* commandPathUrl(ctx, conn, cmd, outputData) {
  const strPath = conn.docId + '/' + cmd.getData();
  const url = yield storage.getSignedUrl(ctx, conn.baseUrl, strPath, commonDefines.c_oAscUrlTypes.Temporary, cmd.getTitle());
  const errorCode = constants.NO_ERROR;
  if (constants.NO_ERROR !== errorCode) {
    outputData.setStatus('err');
    outputData.setData(errorCode);
  } else {
    outputData.setStatus('ok');
    outputData.setData(url);
    outputData.setExtName(pathModule.extname(strPath));
  }
}
function* commandSaveFromOrigin(ctx, cmd, outputData, password) {
  const completeParts = yield* saveParts(ctx, cmd, 'changes0.json');
  if (completeParts) {
    const docPassword = sqlBase.DocumentPassword.prototype.getDocPassword(ctx, password);
    //Use current password for pdf because password is entered in the browser when opening and is set via setPassword
    if (docPassword.initial || docPassword.current) {
      cmd.setPassword(docPassword.initial || docPassword.current);
    }
    //todo setLCID in browser
    const queueData = getSaveTask(ctx, cmd);
    queueData.setFromOrigin(true);
    queueData.setFromChanges(true);
    yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);
  }
  outputData.setStatus('ok');
  outputData.setData(cmd.getSaveKey());
}
function* commandSetPassword(ctx, conn, cmd, outputData) {
  const tenOpenProtectedFile = ctx.getCfg('services.CoAuthoring.server.openProtectedFile', cfgOpenProtectedFile);

  let hasDocumentPassword = false;
  let isDocumentPasswordModified = true;
  let originFormat;
  const selectRes = yield taskResult.select(ctx, cmd.getDocId());
  if (selectRes.length > 0) {
    const row = selectRes[0];
    originFormat = row.change_id;
    hasPasswordCol = undefined !== row.password;
    if (commonDefines.FileStatus.Ok === row.status) {
      const documentPasswordCurEnc = sqlBase.DocumentPassword.prototype.getCurPassword(ctx, row.password);
      if (documentPasswordCurEnc) {
        hasDocumentPassword = true;
        if (cmd.getPassword()) {
          const passwordCurPlain = yield utils.decryptPassword(ctx, documentPasswordCurEnc);
          const passwordPlain = yield utils.decryptPassword(ctx, cmd.getPassword());
          isDocumentPasswordModified = passwordCurPlain !== passwordPlain;
        }
      }
    }
  }
  //https://github.com/ONLYOFFICE/web-apps/blob/4a7879b4f88f315fe94d9f7d97c0ed8aa9f82221/apps/documenteditor/main/app/controller/Main.js#L1652
  //this.appOptions.isPasswordSupport = this.appOptions.isEdit && this.api.asc_isProtectionSupport() && (this.permissions.protect!==false);
  const isPasswordSupport = tenOpenProtectedFile && !conn.user?.view && false !== conn.permissions?.protect;
  ctx.logger.debug(
    'commandSetPassword isEnterCorrectPassword=%s, hasDocumentPassword=%s, hasPasswordCol=%s, isPasswordSupport=%s',
    conn.isEnterCorrectPassword,
    hasDocumentPassword,
    hasPasswordCol,
    isPasswordSupport
  );
  if (isPasswordSupport && hasPasswordCol && hasDocumentPassword && !isDocumentPasswordModified) {
    outputData.setStatus('ok');
  } else if (isPasswordSupport && (conn.isEnterCorrectPassword || !hasDocumentPassword) && hasPasswordCol) {
    const updateMask = new taskResult.TaskResultData();
    updateMask.tenant = ctx.tenant;
    updateMask.key = cmd.getDocId();
    updateMask.status = commonDefines.FileStatus.Ok;

    const newChangesLastDate = new Date();
    newChangesLastDate.setMilliseconds(0); //remove milliseconds avoid issues with MySQL datetime rounding

    const task = new taskResult.TaskResultData();
    task.password = cmd.getPassword() || '';
    let changeInfo = null;
    if (conn.user && (hasDocumentPassword || !formatChecker.isBrowserEditorFormat(originFormat))) {
      changeInfo = task.innerPasswordChange = docsCoServer.getExternalChangeInfo(conn.user, newChangesLastDate.getTime(), conn.lang);
    }

    const upsertRes = yield taskResult.updateIf(ctx, task, updateMask);
    if (upsertRes.affectedRows > 0) {
      outputData.setStatus('ok');
      if (!conn.isEnterCorrectPassword) {
        yield docsCoServer.modifyConnectionForPassword(ctx, conn, true);
      }
      if (changeInfo) {
        const forceSave = yield docsCoServer.editorData.getForceSave(ctx, cmd.getDocId());
        const index = forceSave?.index || 0;
        yield docsCoServer.resetForceSaveAfterChanges(
          ctx,
          cmd.getDocId(),
          newChangesLastDate.getTime(),
          index,
          utils.getBaseUrlByConnection(ctx, conn),
          changeInfo
        );
      }
    } else {
      ctx.logger.debug('commandSetPassword sql update error');
      outputData.setStatus('err');
      outputData.setData(constants.PASSWORD);
    }
  } else {
    outputData.setStatus('err');
    outputData.setData(constants.PASSWORD);
  }
}
function* commandChangeDocInfo(ctx, conn, cmd, outputData) {
  const res = yield docsCoServer.changeConnectionInfo(ctx, conn, cmd);
  if (res) {
    outputData.setStatus('ok');
  } else {
    outputData.setStatus('err');
    outputData.setData(constants.CHANGE_DOC_INFO);
  }
}
function checkAndFixAuthorizationLength(authorization, data) {
  //todo it is stub (remove in future versions)
  //8kb(https://stackoverflow.com/questions/686217/maximum-on-http-header-values) - 1kb(for other headers)
  const res = authorization.length < 7168;
  if (!res) {
    data.setChangeUrl(undefined);
    data.setChangeHistory({});
  }
  return res;
}
function getSavedClaimId(cmd) {
  const saveKey = cmd.getSaveKey();
  if (saveKey !== undefined && saveKey !== null && saveKey !== '') {
    return String(saveKey);
  }
  // SFC tasks normally always have a random saveKey.
  // Keep an explicit, deterministic fallback for older or
  // manually-created tasks so a retry still addresses the same saved-state claim.
  return `fallback:${cmd.getOutputPath() || ''}:${cmd.getStatusInfoIn() || ''}:${cmd.getUserActionId() || cmd.getUserId() || ''}`;
}
// Infrastructure retries double their delay this many times: 1 s to 8 s
// with the default timeout options.  callbackBackoffOptions.retries limits
// only HTTP callback attempts and must not shorten the infrastructure window.
const SFC_RETRY_DELAY_STEPS = 3;
function getSfcRetryDelay(ctx, attempt) {
  const options = ctx.getCfg('services.CoAuthoring.callbackBackoffOptions', cfgCallbackBackoffOptions);
  return retry.createTimeout(Math.min(attempt, SFC_RETRY_DELAY_STEPS), options.timeout);
}
// Releases this document's entry in the shutdown (or redisKey) set once the
// save is done with, whatever the outcome.  Best effort: the save is over, and
// a retry would repeat finished work (an updateVersion event, for one) only
// to remove the entry.  A leftover entry holds a shutdown until its timeout.
function* releaseShutdownEntry(ctx, cmd, docId) {
  try {
    if (docsCoServer.getIsShutdown() || cmd.getRedisKey()) {
      yield docsCoServer.editorStat.removeShutdown(cmd.getRedisKey() || redisKeyShutdown, docId);
    }
  } catch (err) {
    ctx.logger.error('commandSfcCallback: could not release the shutdown entry: %s', err.stack);
  }
}
function* releaseSaveState(ctx, cmd, docId, operationId) {
  // Release what this save holds in editorData when it ends without
  // completing (abandoned or superseded).  Best effort: the memory backend
  // also drops such entries on the next claim-less cleanup of the document.
  try {
    if (cmd.getSavedState()?.claimed) {
      yield docsCoServer.editorData.ackSaved(ctx, docId, operationId);
    }
    yield docsCoServer.editorData.clearSavedCallbackAccepted(ctx, docId, operationId);
  } catch (err) {
    ctx.logger.error('commandSfcCallback: could not release the saved state: %s', err.stack);
  }
}
// Returns true when the row was still this save's (released, or its own
// SaveVersion a reopen resumes), so that its waiting editors may be told.
function* releaseAbandonedTaskRow(ctx, cmd, docId, operationId) {
  // Leave the row to the next open: resumable with the changes the save left
  // (SaveVersion, as after any failed save), or expirable like a
  // completed save when they are gone.  Leave another save's row alone.  If
  // this fails, the open path takes the row over later the same way.
  const selectRes = yield taskResult.select(ctx, docId);
  const row = selectRes.length > 0 ? selectRes[0] : null;
  if (!row) {
    return false;
  }
  const finalSave = getFinalSaveState(row, operationId);
  if (finalSave.last && finalSave.last.operationId !== String(operationId)) {
    // Claim hashes and minute statuses can be reused by another save. Only
    // marker-less rows may fall back to those values without an owner match.
    return false;
  }
  if (commonDefines.FileStatus.SaveVersion === row.status) {
    // Restored already (declined, or not accepted): a reopen resumes it.
    return row.status_info === cmd.getStatusInfoIn();
  }
  if (commonDefines.FileStatus.UpdateVersion !== row.status) {
    return false;
  }
  const ownClaim = getOwnCleanupClaimStatusInfo(ctx, docId, cmd);
  // Its pending status, its claim, or the minute it wrote (an acceptance that
  // could not be persisted): any of them may still have its changes.
  const holdsRow =
    finalSave.pendingOwn ||
    row.status_info === ownClaim ||
    (undefined !== cmd.getSfcStatusInfo() && null !== cmd.getSfcStatusInfo() && row.status_info === cmd.getSfcStatusInfo());
  if (!holdsRow) {
    return false;
  }
  const resumeTask = newTaskMask(ctx, docId, commonDefines.FileStatus.SaveVersion, cmd.getStatusInfoIn());
  const reloadTask = newTaskMask(ctx, docId, commonDefines.FileStatus.UpdateVersion, Math.floor(Date.now() / 60000));
  return !!(yield* takeOverAbandonedSave(ctx, docId, row, resumeTask, reloadTask));
}
function* abandonSfcRetry(ctx, cmd) {
  // Terminal state of a final save: stop retrying, leave the task row
  // expirable and release this operation's state.  GC removes the cache
  // later.  Every step is best effort, because the infrastructure that kept
  // failing may still be down.
  const docId = cmd.getDocId();
  const operationId = getSavedClaimId(cmd);
  ctx.logger.error('commandSfcCallback: giving up after %d infrastructure retries; the task row is left to the next open', getSfcInfraRetries(cmd));
  let released = false;
  try {
    released = yield* releaseAbandonedTaskRow(ctx, cmd, docId, operationId);
  } catch (err) {
    ctx.logger.error('commandSfcCallback: could not release the task row: %s', err.stack);
  }
  yield* releaseSaveState(ctx, cmd, docId, operationId);
  if (released) {
    try {
      // Editors that connected during the save wait for this event, as after
      // any other final save.  Only when the row was still this save's: a new
      // session's editors must not get it.
      // Saved only if the saved state confirmed it (it never may have been read).
      const success = cmd.getCallbackAccepted() === true && cmd.getSavedState()?.success === true;
      yield docsCoServer.publish(ctx, {type: commonDefines.c_oPublishType.updateVersion, ctx, docId, success});
    } catch (err) {
      ctx.logger.error('commandSfcCallback: could not publish updateVersion: %s', err.stack);
    }
  }
  yield* releaseShutdownEntry(ctx, cmd, docId);
}
// Whether the broker has taken this delivery back (the connection dropped).
// Its redelivery then takes the save over, so this attempt must not publish a
// retry too: the save would run twice.
function deliveryWasRequeued(ctx, opt_isDeliveryLive) {
  if (opt_isDeliveryLive && !opt_isDeliveryLive()) {
    ctx.logger.warn('the delivery was requeued by the broker; leaving the retry to the redelivery');
    return true;
  }
  return false;
}
// Returns false when the delivery went back to the broker meanwhile; it must
// then be neither acknowledged nor retried here.
function* scheduleSfcRetryUntilConfirmed(ctx, cmd, opt_isDeliveryLive) {
  // Keep the delivery and this command (attempt counters, callbackDeclined,
  // savedState) in the process until the broker confirms the retry or the save
  // is abandoned.  Every failed publish uses up an infrastructure retry, so
  // this ends within the retry budget.  If the connection dropped, the broker
  // has already requeued the delivery and redelivers it: stop, so that the
  // save does not run twice.  The response consumer has no prefetch limit on
  // RabbitMQ; on ActiveMQ it receives nothing else meanwhile.
  for (;;) {
    if (deliveryWasRequeued(ctx, opt_isDeliveryLive)) {
      return false;
    }
    const attempt = cmd.getAttempt() || 0;
    try {
      yield* scheduleSfcRetry(ctx, cmd);
      return true;
    } catch (err) {
      ctx.logger.error('receiveTask retry scheduling error: %s', err.stack);
      if ((cmd.getAttempt() || 0) === attempt) {
        // Failed before the attempt was counted: count it here to stay bounded.
        cmd.setAttempt(attempt + 1);
      }
      yield new Promise(resolve => setTimeout(resolve, getSfcInfraRetryDelay(ctx, cmd)));
    }
  }
}
// Infrastructure retries so far: `attempt` counts every retry, callbackAttempt
// the HTTP callback ones.
function getSfcInfraRetries(cmd) {
  return (cmd.getAttempt() || 0) - (cmd.getCallbackAttempt() || 0);
}
// The wait before the next infrastructure retry, by the retries so far: the
// schedule getSfcRetryWindow adds up.
function getSfcInfraRetryDelay(ctx, cmd) {
  return getSfcRetryDelay(ctx, getSfcInfraRetries(cmd));
}
// Whether a final save has used up its infrastructure retry budget.
function isSfcRetryBudgetExhausted(ctx, cmd) {
  const options = ctx.getCfg('services.CoAuthoring.callbackBackoffOptions', cfgCallbackBackoffOptions);
  return getSfcInfraRetries(cmd) >= options.infraRetries;
}
// Returns false when the infrastructure retry budget is used up; the save is
// then abandoned instead of rescheduled.
function* scheduleSfcRetry(ctx, cmd, opt_isCallbackRetry) {
  const options = ctx.getCfg('services.CoAuthoring.callbackBackoffOptions', cfgCallbackBackoffOptions);
  const attempt = cmd.getAttempt() || 0;
  const callbackAttempt = cmd.getCallbackAttempt() || 0;
  let timeout;
  if (opt_isCallbackRetry) {
    // HTTP callback failures have their own budget (options.retries), checked
    // before the retry is requested, and back off by their own count.
    timeout = retry.createTimeout(callbackAttempt, options.timeout);
    cmd.setCallbackAttempt(callbackAttempt + 1);
  } else {
    if (isSfcRetryBudgetExhausted(ctx, cmd)) {
      yield* abandonSfcRetry(ctx, cmd);
      return false;
    }
    timeout = getSfcInfraRetryDelay(ctx, cmd);
  }
  // `attempt` counts every retry: handleDeadLetter routes an expired delayed
  // task back as a response only while it is non-zero.
  cmd.setAttempt(attempt + 1);
  // The WOPI parameters (with the user's access token) were for the
  // converter.  A retry comes back here, and the save reads them from the
  // task row: keep the token out of the retry messages, which receiveTask and
  // handleDeadLetter log in full.
  cmd.setWopiParams(undefined);
  const queueData = new commonDefines.TaskQueueData();
  queueData.setCtx(ctx);
  queueData.setCmd(cmd);
  ctx.logger.debug('commandSfcCallback backoff timeout = %d', timeout);
  // Require broker confirmation before releasing the original delivery.
  try {
    yield* docsCoServer.addDelayed(queueData, timeout, undefined, true);
  } catch (err) {
    if (opt_isCallbackRetry) {
      // The callback was not retried: do not use up an HTTP attempt.
      cmd.setCallbackAttempt(callbackAttempt);
    }
    throw err;
  }
  return true;
}
// Returns the value of `additional` after the marker.
function* persistAcceptedCallback(ctx, docId, updateMask, openFromForgotten, operationId, currentAdditional) {
  // The integrator has accepted the final save, so persist that fact before
  // any post-callback work.  The marker is what protects a stale broker
  // delivery from sending the same callback a second time.
  const acceptedMask = {...updateMask};
  const acceptedTask = new taskResult.TaskResultData();
  acceptedTask.status = commonDefines.FileStatus.UpdateVersion;
  acceptedTask.statusInfo = openFromForgotten ? commonDefines.CALLBACK_ACCEPTED_FORGOTTEN_STATUS_INFO : commonDefines.CALLBACK_ACCEPTED_STATUS_INFO;
  const fresh = yield* getAdditionalForMarker(ctx, docId, currentAdditional);
  let additional = setFinalSaveMarker(acceptedTask, fresh, operationId, 'accepted', openFromForgotten);
  let acceptedRes = yield taskResult.updateIf(ctx, acceptedTask, acceptedMask);
  if (!(acceptedRes.affectedRows > 0)) {
    // Metadata appended during the callback can change the snapshot. Refresh
    // only while the last marker still names this operation, and compare the
    // refreshed snapshot atomically too.
    const currentRes = yield taskResult.select(ctx, docId);
    const current = currentRes[0];
    if (
      taskResultMatchesMask(current, {...acceptedMask, additional: null}) &&
      getFinalSaveState(current, operationId).last?.operationId === String(operationId)
    ) {
      acceptedMask.additional = current.additional;
      acceptedTask.replaceAdditional = false;
      additional = setFinalSaveMarker(acceptedTask, current.additional, operationId, 'accepted', openFromForgotten);
      acceptedRes = yield taskResult.updateIf(ctx, acceptedTask, acceptedMask);
    }
  }
  if (!(acceptedRes.affectedRows > 0)) {
    throw new Error('failed to persist accepted final-save callback');
  }
  updateMask.statusInfo = acceptedTask.statusInfo;
  updateMask.additional = additional;
  return additional;
}
// The last step of an accepted save, once cleanup and publication are done.
// `mask` is the row as this save holds it: its accepted status, or the minute
// it wrote on a database without markers.  A delivery that still finds the
// accepted marker afterwards sees the row moved on and does nothing
// (getFinalSaveState: own marker, not pendingOwn).
function* completeAcceptedSave(ctx, docId, openFromForgotten, mask) {
  if (openFromForgotten) {
    // The cache and the row of a session opened from the forgotten
    // file go, so that the next open converts the integrator's file.  Storage
    // first, while the row still keeps opens out; then the row.
    const cleaned = yield deleteDocumentCacheIfOwned(ctx, mask);
    if (!cleaned) {
      yield* retryChangedFinalSaveMetadata(ctx, docId, mask);
      return;
    }
    const removed = yield taskResult.removeIf(ctx, mask);
    if (!(removed.affectedRows > 0)) {
      yield* retryChangedFinalSaveMetadata(ctx, docId, mask);
    }
    return;
  }
  if (isCallbackAcceptedStatusInfo(mask.statusInfo)) {
    // Release the pending status only at the end so that redelivery stays
    // blocked while cleanup or publication can still be retried.  The current
    // minute expires like any other UpdateVersion row.
    const updateTask = new taskResult.TaskResultData();
    updateTask.status = commonDefines.FileStatus.UpdateVersion;
    updateTask.statusInfo = Math.floor(Date.now() / 60000);
    const completedRes = yield taskResult.updateIf(ctx, updateTask, mask);
    if (!(completedRes.affectedRows > 0)) {
      yield* retryChangedFinalSaveMetadata(ctx, docId, mask);
      // Removed (GC or cache cleanup), released or taken over meanwhile.
      ctx.logger.debug('commandSfcCallback: accepted status already released');
    }
  }
}
function getUpdateVersionOwner(row, cmd) {
  if (!row) {
    return null;
  }
  const last = readFinalSaveMarkers(row.additional).at(-1);
  const trackCallbacks = !last || cmd.getStatusInfo() === constants.EDITOR_CHANGES;
  // Keep credentials out of retry messages. Ancillary metadata (e.g. a shard
  // key) may change without changing the session or the save that owns it.
  const identity = [
    row.status,
    row.status_info,
    last,
    last ? undefined : row.additional,
    trackCallbacks ? row.callback : undefined,
    trackCallbacks ? row.user_index : undefined
  ];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function* publishUpdateVersion(ctx, cmd, success) {
  const docId = cmd.getDocId();
  const rows = yield taskResult.select(ctx, docId);
  const row = rows[0];
  const owner = getUpdateVersionOwner(row, cmd);
  const expected = cmd.getUpdateVersionOwner();
  if (expected !== undefined) {
    if (expected !== owner) {
      return;
    }
  } else if (row) {
    const last = readFinalSaveMarkers(row.additional).at(-1);
    if (cmd.getStatusInfo() !== constants.EDITOR_CHANGES && last && last.operationId !== String(getSavedClaimId(cmd))) {
      return;
    }
    // Retries queued before ownership snapshots existed still have to prove
    // that the row is the completed save's, as an original redelivery does.
    if (
      cmd.getUpdateVersionPending() !== undefined &&
      (row.status !== commonDefines.FileStatus.UpdateVersion ||
        commonDefines.isFinalSavePendingStatusInfo(row.status_info) ||
        (last ? last.phase !== 'accepted' : row.status_info !== cmd.getSfcStatusInfo()))
    ) {
      return;
    }
  }
  cmd.setUpdateVersionOwner(owner);
  cmd.setUpdateVersionPending(success);
  const publish = async lockedRow => {
    // Revalidate using the row read on the ownership transaction connection.
    if (getUpdateVersionOwner(lockedRow, cmd) === owner) {
      await docsCoServer.publish(ctx, {type: commonDefines.c_oPublishType.updateVersion, ctx, docId, success});
    }
  };
  if (row) {
    const mask = newTaskMask(ctx, docId, row.status, row.status_info);
    mask.additional = row.additional || null;
    if (!(yield taskResult.withCleanupOwnership(ctx, mask, publish))) {
      yield* retryChangedFinalSaveMetadata(ctx, docId, mask);
    }
  } else {
    const current = yield taskResult.select(ctx, docId);
    yield publish(current[0]);
  }
}
// opt_isDeliveryLive: see receiveTask.
const commandSfcCallback = co.wrap(function* (ctx, cmd, isSfcm, isEncrypted, opt_isDeliveryLive) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  const tenForgottenFilesName = ctx.getCfg('services.CoAuthoring.server.forgottenfilesname', cfgForgottenFilesName);
  const tenCallbackBackoffOptions = ctx.getCfg('services.CoAuthoring.callbackBackoffOptions', cfgCallbackBackoffOptions);

  const docId = cmd.getDocId();
  ctx.logger.debug('Start commandSfcCallback');
  const statusInfo = cmd.getStatusInfo();
  //setUserId - set from changes in convert
  //setUserActionId - used in case of save without changes(forgotten files)
  const userLastChangeId = cmd.getUserId() || cmd.getUserActionId();
  const userLastChangeIndex = cmd.getUserIndex() || cmd.getUserActionIndex();
  let replyStr;
  let isSfcmSuccess = false;
  let isSfcSuccess = false;
  let needRetry = false;
  let needUpdateVersionEvent = !isSfcm && !isEncrypted;
  let callbackRetry = false;
  // The row as this save holds it at the end, for completeAcceptedSave.
  let completionMask;
  let savedClaimId;
  let callbackAccepted = false;
  let callbackCompleted = false;
  let savedOutcomeCompleted = false;
  const updateVersionPending = cmd.getUpdateVersionPending();
  if (!isSfcm && !isEncrypted && (true === updateVersionPending || false === updateVersionPending)) {
    // The save finished and only its updateVersion event failed to go out.
    yield* publishUpdateVersion(ctx, cmd, updateVersionPending);
    yield* releaseShutdownEntry(ctx, cmd, docId);
    ctx.logger.debug('End commandSfcCallback');
    return replyStr;
  }
  if (constants.EDITOR_CHANGES !== statusInfo || isSfcm) {
    const saveKey = docId + cmd.getSaveKey();
    let isError = constants.NO_ERROR != statusInfo;
    const isErrorCorrupted = constants.CONVERT_CORRUPTED == statusInfo;
    const savePathDoc = saveKey + '/' + cmd.getOutputPath();
    const savePathChanges = saveKey + '/changes.zip';
    const savePathHistory = saveKey + '/changesHistory.json';
    const forceSave = cmd.getForceSave();
    const forceSaveType = forceSave ? forceSave.getType() : commonDefines.c_oAscForceSaveTypes.Command;
    const forceSaveUserId = forceSave ? forceSave.getAuthorUserId() : undefined;
    const forceSaveUserIndex = forceSave ? forceSave.getAuthorUserIndex() : undefined;
    const callbackUserIndex = forceSaveUserIndex || 0 === forceSaveUserIndex ? forceSaveUserIndex : userLastChangeIndex;
    savedClaimId = getSavedClaimId(cmd);
    // One acceptance flag for the whole attempt, kept in step with the command
    // that a retry carries.
    // No callback URL is kept: a retry of an accepted callback sends nothing,
    // and the signed download URL would end up in queue messages and logs.
    const markAccepted = openFromForgotten => {
      callbackAccepted = true;
      cmd.setCallbackAccepted(true);
      cmd.setOpenFromForgotten(openFromForgotten === true);
    };
    // Final-save state is tracked only for final saves that can be retried or
    // redelivered: not for forcesaves, and not for encrypted saves (answered
    // synchronously by saveFile).
    const tracked = !isSfcm && !isEncrypted;
    callbackAccepted = cmd.getCallbackAccepted() === true;
    if (!callbackAccepted && tracked) {
      // A retry can learn acceptance from memory before SQL persistence has
      // succeeded.  It must skip the external callback, but still persist the
      // durable task-row marker below.
      const acceptedState = yield docsCoServer.editorData.getSavedCallbackAccepted(ctx, docId, savedClaimId);
      if (acceptedState) {
        markAccepted(acceptedState.openFromForgotten);
      }
    }
    let uri, baseUrl, wopiParams, lastOpenDate;
    const selectRes = yield taskResult.select(ctx, docId);
    const row = selectRes.length > 0 ? selectRes[0] : null;
    const markersSupported = hasAdditionalColumn(row);
    if (row && markersSupported) {
      // Share what this row shows with the auth path's column check.
      exports.hasAdditionalCol = true;
    }
    const ownClaimStatusInfo = getOwnCleanupClaimStatusInfo(ctx, docId, cmd);
    // The column as this attempt last wrote it, for marker pruning.
    let rowAdditional = row?.additional;
    // This save's marker stays visible after later saves append theirs.
    const finalSave = tracked ? getFinalSaveState(row, savedClaimId) : {pendingOwn: false};
    // The phase of the last marker this save wrote.
    let ownPhase = finalSave.own?.phase;
    let callbackAcceptedPersisted = false;
    if (finalSave.own?.phase === 'declined' && callbackAccepted) {
      // Accepted, then reported unsaved: it continues as a declined save.
      callbackAccepted = false;
      cmd.setCallbackAccepted(false);
    }
    if (finalSave.own?.phase === 'accepted') {
      markAccepted(finalSave.own.openFromForgotten);
      callbackAcceptedPersisted = true;
      // The row has moved on (completed, abandoned, removed or taken over):
      // nothing is left for this save to do.
      callbackCompleted = !finalSave.pendingOwn;
    }
    if (row) {
      if (row.callback) {
        uri = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback, callbackUserIndex);
        wopiParams = wopiClient.parseWopiCallback(ctx, uri, row.callback);
      }
      if (row.baseurl) {
        baseUrl = row.baseurl;
      }
      lastOpenDate = row.last_open_date;
    }
    // A callback that got a final answer other than acceptance is not sent
    // again: the decision is in the retry command and, for a redelivery, in the
    // row's marker.
    const callbackDeclined = !callbackAccepted && (cmd.getCallbackDeclined() === true || finalSave.own?.phase === 'declined');
    if (callbackDeclined) {
      cmd.setCallbackDeclined(true);
    }
    // The row holds this save's forgotten-file cleanup claim: the forgotten
    // file is stored and the changes may already be gone, so resume that
    // cleanup instead of restoring SaveVersion.
    const holdsOwnClaim =
      tracked &&
      !!row &&
      commonDefines.FileStatus.UpdateVersion === row.status &&
      row.status_info === ownClaimStatusInfo &&
      (!finalSave.last || finalSave.last.operationId === String(savedClaimId));
    const resumeForgottenCleanup = callbackDeclined && holdsOwnClaim;
    let storeForgotten = false;
    // A saved-state claim taken by an earlier attempt travels with the command.
    let savedClaimed = tracked && cmd.getSavedState()?.claimed === true;
    let acceptedNow = false;
    let statusOk;
    let statusErr;
    if (isSfcm) {
      statusOk = docsCoServer.c_oAscServerStatus.MustSaveForce;
      statusErr = docsCoServer.c_oAscServerStatus.CorruptedForce;
    } else {
      statusOk = docsCoServer.c_oAscServerStatus.MustSave;
      statusErr = docsCoServer.c_oAscServerStatus.Corrupted;
    }
    const recoverTask = new taskResult.TaskResultData();
    recoverTask.status = commonDefines.FileStatus.Ok;
    recoverTask.statusInfo = constants.NO_ERROR;
    let updateIfTask = new taskResult.TaskResultData();
    updateIfTask.status = commonDefines.FileStatus.UpdateVersion;
    updateIfTask.statusInfo = Math.floor(Date.now() / 60000); //minutes
    let updateIfRes;

    const updateMask = newTaskMask(ctx, docId, null, null);
    if (tracked) {
      // Match the operation's marker history as well as its reusable status.
      // SQL compares this snapshot atomically; retries read a fresh snapshot.
      // Oracle normalizes a NULL NCLOB to ''. Neither carries a marker.
      updateMask.additional = rowAdditional || null;
    }
    let superseded = false;
    if (row) {
      // New saves may claim rows containing older markers. An operation whose
      // own marker precedes another save must not reclaim its restored row.
      const canClaimSaveVersion = !tracked || !finalSave.own || finalSave.last.operationId === String(savedClaimId);
      const ownsUpdateVersionRow = () => {
        // Only a row this save can show it holds may be taken over: a late
        // retry or redelivery must not continue on a newer save's row.
        if (finalSave.pendingOwn || callbackCompleted || holdsOwnClaim) {
          return true;
        }
        if (commonDefines.isFinalSavePendingStatusInfo(row.status_info)) {
          // Another save's pending status.
          return false;
        }
        if (finalSave.last) {
          // The row names the save that wrote its status.
          return finalSave.last.operationId === String(savedClaimId);
        }
        // No markers (a row from before them, or no `additional` column): a
        // first delivery takes the row as an untracked save does, a retry only a row that
        // still carries the status it wrote.
        if (!(cmd.getAttempt() > 0)) {
          return true;
        }
        const written = cmd.getSfcStatusInfo();
        return written !== undefined && written !== null && written === row.status_info;
      };
      if (isEncrypted) {
        recoverTask.status = updateMask.status = row.status;
        recoverTask.statusInfo = updateMask.statusInfo = row.status_info;
      } else if (
        (commonDefines.FileStatus.SaveVersion === row.status && cmd.getStatusInfoIn() === row.status_info && canClaimSaveVersion) ||
        (commonDefines.FileStatus.UpdateVersion === row.status && ownsUpdateVersionRow())
      ) {
        if (commonDefines.FileStatus.UpdateVersion === row.status) {
          updateIfRes = {affectedRows: 1};
          if (tracked && !commonDefines.isFinalSavePendingStatusInfo(row.status_info)) {
            // Taken over as it is: a retry recognizes the row by this value.
            cmd.setSfcStatusInfo(row.status_info);
          }
        }
        recoverTask.status = commonDefines.FileStatus.SaveVersion;
        recoverTask.statusInfo = cmd.getStatusInfoIn();
        updateMask.status = row.status;
        updateMask.statusInfo = row.status_info;
        if (resumeForgottenCleanup) {
          // cleanupCacheIf recognizes its claim by the mask it claimed with.
          updateMask.status = commonDefines.FileStatus.SaveVersion;
          updateMask.statusInfo = cmd.getStatusInfoIn();
          updateIfTask = undefined;
        }
      } else {
        updateIfRes = {affectedRows: 0};
        // A final save whose row a newer save or a new session owns now.
        superseded = !isSfcm;
      }
    } else if (callbackAccepted && tracked) {
      // Accepted, and the row is gone: removed by this save's own completion,
      // by GC or by a WOPI cache invalidation.  Nothing is left to clean, and a
      // new session may be starting, so touch nothing.
      superseded = true;
    } else {
      isError = true;
    }
    if (superseded || (tracked && callbackCompleted)) {
      // Stop before anything touches the row, its cache, its changes, the
      // forgotten file or the editor data: they are the new owner's, or this
      // save already finished (completed, given up or taken over).
      if (superseded) {
        ctx.logger.warn("commandSfcCallback: task row status=%s is not this save's; stopping", row?.status);
      } else {
        ctx.logger.debug('commandSfcCallback: this final save already finished');
      }
      // Still as this save's completion left it: its minute with its
      // acceptance as the last marker, or no row after a session opened from
      // the forgotten file (any other save leaves its row; one gone was removed
      // by GC or a WOPI invalidation).  A delivery that finds this is a redelivery after a
      // crash between the completion and the updateVersion event, which then
      // may not have gone out: publish it, so that editors who joined during
      // the save are not left view-only.  A duplicate only repeats a reload
      // prompt.  Never on a row that an open has taken over (Ok, None or its
      // hold) or a newer save holds.
      const completedRow = row
        ? commonDefines.FileStatus.UpdateVersion === row.status &&
          !commonDefines.isFinalSavePendingStatusInfo(row.status_info) &&
          'accepted' === finalSave.last?.phase &&
          finalSave.last.operationId === String(savedClaimId)
        : cmd.getOpenFromForgotten() === true;
      yield* releaseSaveState(ctx, cmd, docId, savedClaimId);
      if (tracked && callbackAccepted && completedRow) {
        const success = cmd.getSavedState()?.success !== false;
        // A failed publication is retried alone (see above).
        yield* publishUpdateVersion(ctx, cmd, success);
      }
      yield* releaseShutdownEntry(ctx, cmd, docId);
      ctx.logger.debug('End commandSfcCallback');
      return replyStr;
    }
    let outputSfc;
    if ((uri && baseUrl && userLastChangeId) || callbackAccepted) {
      ctx.logger.debug('Callback commandSfcCallback: callback = %s', uri);
      outputSfc = new commonDefines.OutputSfcData(docId);
      outputSfc.setEncrypted(isEncrypted);
      const users = [];
      let isOpenFromForgotten = cmd.getOpenFromForgotten() === true;
      if (userLastChangeId) {
        users.push(userLastChangeId);
      }
      outputSfc.setUsers(users);
      if (!isSfcm) {
        const actions = [];
        //use UserId case UserActionId miss in gc convertion
        const userActionId = cmd.getUserActionId() || cmd.getUserId();
        if (userActionId) {
          actions.push(new commonDefines.OutputAction(commonDefines.c_oAscUserAction.Out, userActionId));
        }
        outputSfc.setActions(actions);
      } else if (forceSaveUserId) {
        outputSfc.setActions([new commonDefines.OutputAction(commonDefines.c_oAscUserAction.ForceSaveButton, forceSaveUserId)]);
      }
      outputSfc.setUserData(cmd.getUserData());
      const formsData = cmd.getFormData();
      // A declined save's retry never sends the callback: building it would only
      // add storage requests whose failure ends the save as an error.
      if (formsData && !callbackAccepted && !callbackDeclined) {
        const formsDataPath = saveKey + '/formsdata.json';
        const formsBuffer = Buffer.from(JSON.stringify(formsData), 'utf8');
        yield storage.putObject(ctx, formsDataPath, formsBuffer, formsBuffer.length);
        const formsDataUrl = yield storage.getSignedUrl(ctx, baseUrl, formsDataPath, commonDefines.c_oAscUrlTypes.Temporary);
        outputSfc.setFormsDataUrl(formsDataUrl);
      }
      if ((!isError || isErrorCorrupted) && !callbackAccepted && !callbackDeclined) {
        try {
          const forgotten = yield storage.listObjects(ctx, docId, tenForgottenFiles);
          let isSendHistory = 0 === forgotten.length;
          if (!isSendHistory) {
            //check indicator file to determine if opening was from the forgotten file
            const forgottenMarkPath = docId + '/' + tenForgottenFilesName + '.txt';
            const forgottenMark = yield storage.listObjects(ctx, forgottenMarkPath);
            isOpenFromForgotten = 0 !== forgottenMark.length;
            isSendHistory = !isOpenFromForgotten;
            ctx.logger.debug('commandSfcCallback forgotten no empty: isSendHistory = %s', isSendHistory);
          }
          if (isSendHistory && !isEncrypted) {
            //don't send history info because changes isn't from file in storage
            const data = yield storage.getObject(ctx, savePathHistory);
            outputSfc.setChangeHistory(JSON.parse(data.toString('utf-8')));
            const changeUrl = yield storage.getSignedUrl(ctx, baseUrl, savePathChanges, commonDefines.c_oAscUrlTypes.Temporary);
            outputSfc.setChangeUrl(changeUrl);
          } else {
            //for backward compatibility. remove this when Community is ready
            outputSfc.setChangeHistory({});
          }
          const url = yield storage.getSignedUrl(ctx, baseUrl, savePathDoc, commonDefines.c_oAscUrlTypes.Temporary);
          outputSfc.setUrl(url);
          outputSfc.setExtName(pathModule.extname(savePathDoc));
        } catch (e) {
          ctx.logger.error('Error commandSfcCallback: %s', e.stack);
        }
        if (outputSfc.getUrl() && outputSfc.getUsers().length > 0) {
          outputSfc.setStatus(statusOk);
        } else {
          isError = true;
        }
      }
      if (isError) {
        outputSfc.setStatus(statusErr);
      }
      if (isSfcm) {
        const selectRes = yield taskResult.select(ctx, docId);
        const row = selectRes.length > 0 ? selectRes[0] : null;
        //send only if FileStatus.Ok to prevent forcesave after final save
        if (row && row.status == commonDefines.FileStatus.Ok) {
          if (forceSave) {
            const forceSaveDate = forceSave.getTime() ? new Date(forceSave.getTime()) : new Date();
            outputSfc.setForceSaveType(forceSaveType);
            outputSfc.setLastSave(forceSaveDate.toISOString());
          }
          if (forceSave && forceSaveType === commonDefines.c_oAscForceSaveTypes.Internal) {
            //send to browser only if internal forcesave
            isSfcmSuccess = true;
          } else {
            try {
              if (wopiParams) {
                if (outputSfc.getUrl()) {
                  if (forceSaveType === commonDefines.c_oAscForceSaveTypes.Form) {
                    yield processWopiSaveAs(ctx, cmd);
                    replyStr = JSON.stringify({error: 0});
                  } else {
                    const isAutoSave =
                      forceSaveType !== commonDefines.c_oAscForceSaveTypes.Button && forceSaveType !== commonDefines.c_oAscForceSaveTypes.Form;
                    replyStr = yield processWopiPutFile(ctx, docId, wopiParams, savePathDoc, userLastChangeId, true, isAutoSave, false);
                  }
                } else {
                  replyStr = JSON.stringify({error: 1, descr: 'wopi: no file'});
                }
              } else {
                replyStr = yield docsCoServer.sendServerRequest(ctx, uri, outputSfc, checkAndFixAuthorizationLength);
              }
              const replyData = docsCoServer.parseReplyData(ctx, replyStr);
              isSfcmSuccess = replyData && commonDefines.c_oAscServerCommandErrors.NoError == replyData.error;
              if (replyData && commonDefines.c_oAscServerCommandErrors.NoError != replyData.error) {
                ctx.logger.warn('sendServerRequest returned an error: data = %s', replyStr);
              }
            } catch (err) {
              ctx.logger.error('sendServerRequest error: url = %s;data = %j %s', uri, outputSfc, err.stack);
            }
          }
        }
      } else {
        //if anybody in document stop save
        const editorsCount = callbackAccepted ? 0 : yield docsCoServer.getEditorsCountPromise(ctx, docId);
        ctx.logger.debug('commandSfcCallback presence: count = %d', editorsCount);
        if (0 === editorsCount || (isEncrypted && 1 === editorsCount)) {
          let updateIfApplied = false;
          if (!updateIfRes) {
            if (tracked) {
              // Name this save on the row in the same write, so that every later
              // attempt or redelivery, even after a lost reply, can tell the row
              // is its own.  The status written is the fallback without markers.
              cmd.setSfcStatusInfo(updateIfTask.statusInfo);
              if (markersSupported) {
                const fresh = yield* getAdditionalForMarker(ctx, docId, rowAdditional);
                ownPhase = callbackDeclined ? 'declined' : 'sending';
                rowAdditional = setFinalSaveMarker(updateIfTask, fresh, savedClaimId, ownPhase, cmd.getOpenFromForgotten());
              }
            }
            updateIfRes = yield taskResult.updateIf(ctx, updateIfTask, updateMask);
            updateIfApplied = updateIfRes.affectedRows > 0;
          }
          if (updateIfRes.affectedRows > 0) {
            let notModified;
            if (!callbackAccepted) {
              const actualForceSave = yield docsCoServer.editorData.getForceSave(ctx, docId);
              const forceSaveDate = actualForceSave && actualForceSave.time ? new Date(actualForceSave.time) : new Date();
              notModified = actualForceSave && true === actualForceSave.ended;
              outputSfc.setLastSave(forceSaveDate.toISOString());
              outputSfc.setNotModified(notModified);
            }

            if (updateIfApplied) {
              // This attempt moved the row to UpdateVersion: later conditional
              // updates must match what it wrote.
              updateMask.status = updateIfTask.status;
              updateMask.statusInfo = updateIfTask.statusInfo;
              if (tracked && markersSupported) {
                updateMask.additional = rowAdditional;
              }
            }
            // Otherwise the row was already UpdateVersion when it was read (a
            // retry, a redelivery after a crash, an accepted callback), and the
            // mask keeps the values that were read.  The current minute would
            // stop matching once a retry lands in a later minute.
            if (!callbackAccepted && !callbackDeclined) {
              try {
                if (wopiParams) {
                  if (outputSfc.getUrl()) {
                    replyStr = yield processWopiPutFile(ctx, docId, wopiParams, savePathDoc, userLastChangeId, !notModified, false, true);
                  } else {
                    replyStr = JSON.stringify({error: 1, descr: 'wopi: no file'});
                  }
                } else {
                  replyStr = yield docsCoServer.sendServerRequest(ctx, uri, outputSfc, checkAndFixAuthorizationLength);
                }
              } catch (err) {
                ctx.logger.error('sendServerRequest error: url = %s;data = %j %s', uri, outputSfc, err.stack);
                const retryHttpStatus = new MultiRange(tenCallbackBackoffOptions.httpStatus);
                if (!isEncrypted && !docsCoServer.getIsShutdown() && (!err.statusCode || retryHttpStatus.has(err.statusCode.toString()))) {
                  // Count only HTTP attempts here: infrastructure retries must
                  // not use up the callback's own budget.
                  const callbackAttempt = cmd.getCallbackAttempt() || 0;
                  if (callbackAttempt < tenCallbackBackoffOptions.retries) {
                    needRetry = true;
                    callbackRetry = true;
                  } else {
                    ctx.logger.warn('commandSfcCallback backoff limit exceeded');
                  }
                }
              }
              const replyData = docsCoServer.parseReplyData(ctx, replyStr);
              if (replyData && commonDefines.c_oAscServerCommandErrors.NoError == replyData.error) {
                // Keep the acceptance in both the retry command and the task row.
                markAccepted(isOpenFromForgotten);
                acceptedNow = true;
                // An encrypted save is answered synchronously (saveFile) and is
                // never retried or redelivered, so its acceptance is not
                // tracked: a database error after acceptance must not fail a
                // save the integrator already has.  Without markers the
                // acceptance is not persisted either (as for untracked saves): an unowned
                // pending status could not be released.
                if (tracked && markersSupported) {
                  // Record acceptance in memory before SQL. If SQL persistence
                  // fails, an original broker redelivery in this worker must
                  // still skip the callback while the retry repairs the row.
                  yield docsCoServer.editorData.setSavedCallbackAccepted(ctx, docId, savedClaimId, {openFromForgotten: isOpenFromForgotten});
                  rowAdditional = yield* persistAcceptedCallback(ctx, docId, updateMask, isOpenFromForgotten, savedClaimId, rowAdditional);
                  callbackAcceptedPersisted = true;
                }
              } else if (replyData && commonDefines.c_oAscServerCommandErrors.NoError != replyData.error) {
                ctx.logger.warn('sendServerRequest returned an error: data = %s', replyStr);
              }
              if (!callbackAccepted && !needRetry) {
                // A final answer other than acceptance (an error reply, a failed
                // WOPI PutFile, a non-retryable HTTP status or an exhausted HTTP
                // budget): this save goes to the forgotten-file path.  If that
                // path has to be retried, the retry must not send the callback
                // again.
                cmd.setCallbackDeclined(true);
              }
            }
            let requestRes = false;
            if (callbackAccepted) {
              //in the case of a community server, a request will come to the Command Service, check the result
              if (
                !callbackAcceptedPersisted &&
                tracked &&
                markersSupported &&
                row &&
                updateMask.statusInfo !== undefined &&
                updateMask.statusInfo !== null
              ) {
                rowAdditional = yield* persistAcceptedCallback(
                  ctx,
                  docId,
                  updateMask,
                  cmd.getOpenFromForgotten() === true,
                  savedClaimId,
                  rowAdditional
                );
                callbackAcceptedPersisted = true;
              }
              let savedState = cmd.getSavedState();
              if (!savedState) {
                // Keep the saved-state claim attached to this operation until
                // cleanup and acknowledgement succeed; retries then resume
                // from the cleanup phase instead of consuming a new result.
                savedState = yield consumeSavedState(docsCoServer.editorData, ctx, docId, savedClaimId);
                // Retain the decision with the retry command so delayed retries
                // do not need to claim the saved state again.
                cmd.setSavedState(savedState);
              }
              requestRes = savedState.success;
              savedClaimed = savedState.claimed;
              if (!requestRes && tracked) {
                // The integrator answered the callback but reported the save as
                // failed (saved state): its file does not have these changes.
                // Continue as a declined save: restore SaveVersion with a
                // declined marker below and keep the changes until the forgotten
                // file is stored.  The marker also keeps a redelivery from
                // sending the callback again.
                callbackAccepted = false;
                cmd.setCallbackAccepted(false);
                cmd.setCallbackDeclined(true);
                yield docsCoServer.editorData.clearSavedCallbackAccepted(ctx, docId, savedClaimId);
              }
            }
            if (requestRes) {
              isSfcSuccess = true;
              updateIfTask = undefined;
              const cleanupResult = yield docsCoServer.cleanDocumentOnExitPromise(
                ctx,
                docId,
                true,
                callbackUserIndex,
                savedClaimed ? savedClaimId : undefined,
                // Delete the changes only while the row still holds this save's
                // status: a slow attempt must not delete a new session's edits.
                tracked ? updateMask : undefined
              );
              savedOutcomeCompleted = cleanupResult === true;
              needRetry = !savedOutcomeCompleted && !isEncrypted;
              if (cleanupResult === true && isOpenFromForgotten && !tracked) {
                //remove forgotten file in cache
                yield cleanupCache(ctx, docId);
              }
              // A tracked save removes the forgotten-file cache at completion.
              if (lastOpenDate && acceptedNow) {
                //todo error case
                const time = new Date() - lastOpenDate;
                ctx.logger.debug('commandSfcCallback saveAfterEditingSessionClosed=%d', time);
                if (clientStatsD) {
                  clientStatsD.timing('coauth.saveAfterEditingSessionClosed', time);
                }
              }
            } else {
              storeForgotten = true;
              // Not accepted (a retryable failure, a final answer other than
              // acceptance, or accepted but reported unsaved): restore SaveVersion
              // below, so that a retry starts from the row as it
              // was and a reopen within expire.updateVersionStatus is not
              // view-only.  An encrypted save gets its previous status back.
            }
          } else {
            yield* retryChangedFinalSaveMetadata(ctx, docId, updateMask);
            updateIfTask = undefined;
            needUpdateVersionEvent = false;
          }
        } else {
          needUpdateVersionEvent = false;
        }
      }
    } else {
      ctx.logger.warn('Empty Callback=%s or baseUrl=%s or userLastChangeId=%s commandSfcCallback', uri, baseUrl, userLastChangeId);
      storeForgotten = true;
      if (tracked) {
        // No callback to send: this save goes to the forgotten-file path like a
        // declined one, and its marker dates its cleanup claim.
        cmd.setCallbackDeclined(true);
      }
    }
    if (undefined !== updateIfTask && !isSfcm && !row) {
      // No row to restore (removed by this save's own cleanup, or GC): a
      // condition-less restore would hit whatever row appears meanwhile.
      updateIfTask = undefined;
    }
    if (undefined !== updateIfTask && !isSfcm) {
      ctx.logger.debug('commandSfcCallback restore %d status', recoverTask.status);
      updateIfTask.status = recoverTask.status;
      updateIfTask.statusInfo = recoverTask.statusInfo;
      // Not the attempt's marker again.
      updateIfTask.additional = null;
      updateIfTask.replaceAdditional = false;
      if (cmd.getCallbackDeclined() === true && 'declined' !== ownPhase && markersSupported && tracked) {
        // Record the decision on the row, so that a redelivery of this save
        // (which carries no retry state) does not send the callback again.
        const fresh = yield* getAdditionalForMarker(ctx, docId, rowAdditional);
        rowAdditional = setFinalSaveMarker(updateIfTask, fresh, savedClaimId, 'declined', cmd.getOpenFromForgotten());
      }
      updateIfRes = yield taskResult.updateIf(ctx, updateIfTask, updateMask);
      let currentRes;
      if (!(updateIfRes.affectedRows > 0) && tracked) {
        currentRes = yield taskResult.select(ctx, docId);
        // A restore of the values the row already has (it is SaveVersion and
        // no marker is added: a retry without a callback, editors present, no
        // `additional` column) changes nothing if an open refreshed
        // last_open_date in the same second, and MySQL and MariaDB report that
        // as 0 rows: they count changed rows, not matched ones.
        const unchanged =
          currentRes.length > 0 &&
          !updateIfTask.additional &&
          updateMask.status === updateIfTask.status &&
          updateMask.statusInfo === updateIfTask.statusInfo &&
          taskResultMatchesMask(currentRes[0], updateMask);
        if (unchanged) {
          updateIfRes = {affectedRows: 1};
        }
      }
      if (updateIfRes.affectedRows > 0) {
        updateMask.status = updateIfTask.status;
        updateMask.statusInfo = updateIfTask.statusInfo;
        if (tracked && markersSupported) {
          updateMask.additional = rowAdditional;
        }
        if (tracked) {
          // The row no longer carries the minute this save wrote: a newer save
          // may write the same minute, and a retry must not take that row.
          cmd.setSfcStatusInfo(undefined);
        }
      } else {
        ctx.logger.debug('commandSfcCallback restore %d status failed', recoverTask.status);
        if (tracked && currentRes.length > 0) {
          if (
            taskResultMatchesMask(currentRes[0], {...updateMask, additional: null}) &&
            getFinalSaveState(currentRes[0], savedClaimId).last?.operationId === String(savedClaimId)
          ) {
            // The same operation, with metadata appended meanwhile: retry with
            // its fresh snapshot instead of releasing its saved-state claim.
            throw new Error('final-save metadata changed during status restoration');
          }
          // The row is someone else's now: an open that took it over (and
          // resumed the changes or found them gone), or a newer save.  Stop as
          // a superseded save: a forgotten file would shadow that session's
          // document, and the updateVersion event is not for its editors.  A
          // removed row cannot prove ownership of the shared forgotten file.
          ctx.logger.warn("commandSfcCallback: task row is no longer this save's; stopping");
          yield* releaseSaveState(ctx, cmd, docId, savedClaimId);
          yield* releaseShutdownEntry(ctx, cmd, docId);
          ctx.logger.debug('End commandSfcCallback');
          return replyStr;
        }
      }
    }
    if (storeForgotten && !needRetry && !isEncrypted && (!isError || isErrorCorrupted)) {
      // A resumed cleanup claim means the forgotten file is already stored.
      let forgottenStored = resumeForgottenCleanup;
      try {
        if (!forgottenStored) {
          ctx.logger.warn('storeForgotten');
          const forgottenName = tenForgottenFilesName + pathModule.extname(cmd.getOutputPath());
          const copyForgottenFile = () => storage.copyObject(ctx, savePathDoc, docId + '/' + forgottenName, undefined, tenForgottenFiles);
          // The row is SaveVersion again, so an open may start a new session.
          // Hold ownership until the shared-file write has finished.
          if (!tracked) {
            yield copyForgottenFile();
          } else if (!row || !(yield taskResult.withCleanupOwnership(ctx, updateMask, copyForgottenFile))) {
            if (row) {
              yield* retryChangedFinalSaveMetadata(ctx, docId, updateMask);
            }
            yield* releaseSaveState(ctx, cmd, docId, savedClaimId);
            yield* releaseShutdownEntry(ctx, cmd, docId);
            return replyStr;
          }
          forgottenStored = true;
        }
      } catch (err) {
        ctx.logger.error('Error storeForgotten: %s', err.stack);
        if (!isSfcm) {
          throw err;
        }
      }
      if (!isSfcm && forgottenStored) {
        // Only remove cached files and changes when backend cleanup completes,
        // and only while the row is still this save's: a session opened since
        // owns the editor data and the WOPI lock.
        const cleanupResult = yield docsCoServer.cleanDocumentOnExitPromise(
          ctx,
          docId,
          false,
          callbackUserIndex,
          savedClaimed ? savedClaimId : undefined,
          tracked && row ? (resumeForgottenCleanup ? {...updateMask, status: row.status, statusInfo: row.status_info} : updateMask) : undefined
        );
        if (cleanupResult === true) {
          // Keep the saved-state claim pending until cache cleanup completes.
          // An accepted callback keeps its task row as a durable tombstone
          // until the completion marker is persisted after publication.  A
          // declined save removes the row.
          const cleanupRes = yield cleanupCacheIf(ctx, updateMask);
          ctx.logger.debug('storeForgotten cleanupRes=%s', cleanupRes);
          savedOutcomeCompleted = cleanupRes === true;
          needRetry = !savedOutcomeCompleted && !isEncrypted;
        } else {
          ctx.logger.debug('storeForgotten skipped terminal cleanup while document is active');
          needRetry = true;
        }
      }
    }
    if (forceSave) {
      yield* docsCoServer.setForceSave(ctx, docId, forceSave, cmd, isSfcmSuccess && !isError, outputSfc?.getUrl());
    }
    if (needRetry) {
      if (!deliveryWasRequeued(ctx, opt_isDeliveryLive)) {
        // If the budget is used up, scheduleSfcRetry abandons the save instead;
        // needRetry stays set so that nothing below reports it as completed.
        yield* scheduleSfcRetry(ctx, cmd, callbackRetry);
      }
    }
    // Acknowledge only completed saves or preserved forgotten files after cleanup.
    // Retain claims on retries, declined cleanup, and terminal failures that skip
    // cleanup (conversion errors, encrypted saves, or missing output). An error
    // notification alone does not complete the claimed outcome.
    if (savedOutcomeCompleted && !needRetry) {
      if (savedClaimed) {
        yield docsCoServer.editorData.ackSaved(ctx, docId, savedClaimId);
      }
      yield docsCoServer.editorData.clearSavedCallbackAccepted(ctx, docId, savedClaimId);
    }
    completionMask = updateMask;
  } else {
    ctx.logger.debug('commandSfcCallback cleanDocumentOnExitNoChangesPromise');
    // The "closed without changes" status goes to the integrator once.  A retry
    // repeats only the cleanup, so record in the command that it was sent
    // before a failure reaches the retry.
    const closeStatus = {sent: cmd.getCloseStatusSent() === true};
    if (cmd.getAttempt() > 0 && !isEncrypted && (yield docsCoServer.getEditorsCountPromise(ctx, docId)) > 0) {
      // Reopened since the first attempt: its editor data and WOPI lock are the
      // new session's, which cleans up when it closes.
      ctx.logger.debug('commandSfcCallback: document reopened; no cleanup left for this close');
      yield* releaseShutdownEntry(ctx, cmd, docId);
      ctx.logger.debug('End commandSfcCallback');
      return replyStr;
    }
    let cleanupResult;
    try {
      cleanupResult = yield docsCoServer.cleanDocumentOnExitNoChangesPromise(ctx, docId, undefined, userLastChangeIndex, true, false, closeStatus);
    } finally {
      if (closeStatus.sent) {
        cmd.setCloseStatusSent(true);
      }
    }
    if (cleanupResult !== true && !isEncrypted) {
      needRetry = true;
      if (!deliveryWasRequeued(ctx, opt_isDeliveryLive)) {
        yield* scheduleSfcRetry(ctx, cmd);
      }
    }
  }

  // A callback accepted during this attempt must be completed too, not only
  // one accepted by an earlier attempt.  Before the event: editors
  // reload on it and must find the row (or no row) the save leaves behind.
  if (callbackAccepted && !isEncrypted && savedOutcomeCompleted && !needRetry) {
    yield* completeAcceptedSave(ctx, docId, cmd.getOpenFromForgotten() === true, completionMask);
  }

  if (needUpdateVersionEvent && !needRetry) {
    // Everything else is done: a retry after a failed publication only
    // publishes (see the start of commandSfcCallback).
    yield* publishUpdateVersion(ctx, cmd, isSfcSuccess);
  }

  // A forcesave leaves the shutdown entry to its final save.
  if (!needRetry && (!isSfcm || cmd.getRedisKey())) {
    yield* releaseShutdownEntry(ctx, cmd, docId);
  }
  ctx.logger.debug('End commandSfcCallback');
  return replyStr;
});
function* processWopiPutFile(ctx, docId, wopiParams, savePathDoc, userLastChangeId, isModifiedByUser, isAutosave, isExitSave) {
  let res = '{"error": 1}';
  const metadata = yield storage.headObject(ctx, savePathDoc);
  const streamObj = yield storage.createReadStream(ctx, savePathDoc);
  const postRes = yield wopiClient.putFile(
    ctx,
    wopiParams,
    null,
    streamObj.readStream,
    metadata.ContentLength,
    userLastChangeId,
    isModifiedByUser,
    isAutosave,
    isExitSave
  );
  if (postRes) {
    res = '{"error": 0}';
    const body = wopiClient.parsePutFileResponse(ctx, postRes);
    //collabora nexcloud connector
    if (body?.LastModifiedTime) {
      const lastModifiedTimeInfo = wopiClient.getWopiModifiedMarker(wopiParams, body.LastModifiedTime);
      yield commandOpenStartPromise(ctx, docId, undefined, lastModifiedTimeInfo);
    }
  }
  return res;
}
function* commandSendMMCallback(ctx, cmd) {
  const docId = cmd.getDocId();
  ctx.logger.debug('Start commandSendMMCallback');
  const saveKey = docId + cmd.getSaveKey();
  const statusInfo = cmd.getStatusInfo();
  const outputSfc = new commonDefines.OutputSfcData(docId);
  if (constants.NO_ERROR == statusInfo) {
    outputSfc.setStatus(docsCoServer.c_oAscServerStatus.MailMerge);
  } else {
    outputSfc.setStatus(docsCoServer.c_oAscServerStatus.Corrupted);
  }
  const mailMergeSendData = cmd.getMailMergeSend();
  const outputMailMerge = new commonDefines.OutputMailMerge(mailMergeSendData);
  outputSfc.setMailMerge(outputMailMerge);
  outputSfc.setUsers([mailMergeSendData.getUserId()]);
  const data = yield storage.getObject(ctx, saveKey + '/' + cmd.getOutputPath());
  const xml = data.toString('utf8');
  const files = xml.match(/[< ]file.*?\/>/g);
  const recordRemain = mailMergeSendData.getRecordTo() - mailMergeSendData.getRecordFrom() + 1;
  const recordIndexStart = mailMergeSendData.getRecordCount() - recordRemain;
  for (let i = 0; i < files.length; ++i) {
    const file = files[i];
    const fieldRes = /field=["'](.*?)["']/.exec(file);
    outputMailMerge.setTo(fieldRes[1]);
    outputMailMerge.setRecordIndex(recordIndexStart + i);
    const pathRes = /path=["'](.*?)["']/.exec(file);
    const signedUrl = yield storage.getSignedUrl(
      ctx,
      mailMergeSendData.getBaseUrl(),
      saveKey + '/' + pathRes[1],
      commonDefines.c_oAscUrlTypes.Temporary
    );
    outputSfc.setUrl(signedUrl);
    outputSfc.setExtName(pathModule.extname(pathRes[1]));
    const uri = mailMergeSendData.getUrl();
    let replyStr = null;
    try {
      replyStr = yield docsCoServer.sendServerRequest(ctx, uri, outputSfc);
    } catch (err) {
      replyStr = null;
      ctx.logger.error('sendServerRequest error: url = %s;data = %j %s', uri, outputSfc, err.stack);
    }
    const replyData = docsCoServer.parseReplyData(ctx, replyStr);
    if (!(replyData && commonDefines.c_oAscServerCommandErrors.NoError == replyData.error)) {
      let recordErrorCount = mailMergeSendData.getRecordErrorCount();
      recordErrorCount++;
      outputMailMerge.setRecordErrorCount(recordErrorCount);
      mailMergeSendData.setRecordErrorCount(recordErrorCount);
    }
    if (replyData && commonDefines.c_oAscServerCommandErrors.NoError != replyData.error) {
      ctx.logger.warn('sendServerRequest returned an error: data = %s', docId, replyStr);
    }
  }
  const newRecordFrom = mailMergeSendData.getRecordFrom() + Math.max(files.length, 1);
  if (newRecordFrom <= mailMergeSendData.getRecordTo()) {
    mailMergeSendData.setRecordFrom(newRecordFrom);
    yield* addRandomKeyTaskCmd(ctx, cmd);
    const queueData = getSaveTask(ctx, cmd);
    yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_LOW);
  } else {
    ctx.logger.debug('End MailMerge');
  }
  ctx.logger.debug('End commandSendMMCallback');
}

exports.openDocument = function (ctx, conn, cmd, opt_upsertRes, opt_bIsRestore) {
  return co(function* () {
    let outputData;
    try {
      let startDate = null;
      if (clientStatsD) {
        startDate = new Date();
      }
      ctx.logger.debug('Start command: %s', JSON.stringify(cmd));
      outputData = new OutputData(cmd.getCommand());
      let res = true;
      switch (cmd.getCommand()) {
        case 'open':
          yield* commandOpen(ctx, conn, cmd, outputData, opt_upsertRes, opt_bIsRestore);
          break;
        case 'reopen':
          res = yield* commandReopen(ctx, conn, cmd, outputData);
          break;
        case 'imgurls':
          yield* commandImgurls(ctx, conn, cmd, outputData);
          break;
        case 'pathurl':
          yield* commandPathUrl(ctx, conn, cmd, outputData);
          break;
        case 'pathurls':
          yield* commandPathUrls(ctx, conn, cmd.getData(), outputData);
          break;
        case 'setpassword':
          yield* commandSetPassword(ctx, conn, cmd, outputData);
          break;
        case 'changedocinfo':
          yield* commandChangeDocInfo(ctx, conn, cmd, outputData);
          break;
        default:
          res = false;
          break;
      }
      if (!res) {
        outputData.setStatus('err');
        outputData.setData(constants.UNKNOWN);
      }
      if (clientStatsD) {
        clientStatsD.timing('coauth.openDocument.' + cmd.getCommand(), new Date() - startDate);
      }
    } catch (e) {
      ctx.logger.error('Error openDocument: %s', e.stack);
      if (!outputData) {
        outputData = new OutputData();
      }
      outputData.setStatus('err');
      outputData.setData(constants.UNKNOWN);
    } finally {
      if (outputData?.getStatus()) {
        ctx.logger.debug('Response command: %s', JSON.stringify(outputData));
        docsCoServer.sendData(ctx, conn, new OutputDataWrap('documentOpen', outputData));
      }
      ctx.logger.debug('End command');
    }
  });
};
exports.downloadAs = function (req, res) {
  return co(function* () {
    let docId = 'null';
    const ctx = new operationContext.Context();
    try {
      let startDate = null;
      if (clientStatsD) {
        startDate = new Date();
      }
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      const strCmd = req.query['cmd'];
      const cmd = new commonDefines.InputCommand(JSON.parse(strCmd));
      docId = cmd.getDocId();
      let userId = cmd.getUserId();
      ctx.setDocId(docId);
      ctx.setUserId(userId);
      ctx.logger.debug('Start downloadAs: %s', strCmd);
      const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

      if (tenTokenEnableBrowser || cmd.getTokenDownload() || cmd.getTokenSession()) {
        let isValidJwt = false;
        if (cmd.getTokenDownload()) {
          const checkJwtRes = yield docsCoServer.checkJwt(ctx, cmd.getTokenDownload(), commonDefines.c_oAscSecretType.Browser);
          if (checkJwtRes.decoded) {
            isValidJwt = true;
            cmd.setFormat(checkJwtRes.decoded.fileType);
            cmd.setUrl(checkJwtRes.decoded.url);
            cmd.setWithAuthorization(true);
          } else {
            ctx.logger.warn('Error downloadAs jwt: %s', checkJwtRes.description);
          }
        } else {
          const checkJwtRes = yield docsCoServer.checkJwt(ctx, cmd.getTokenSession(), commonDefines.c_oAscSecretType.Session);
          if (checkJwtRes.decoded) {
            const decoded = checkJwtRes.decoded;
            const doc = checkJwtRes.decoded.document;
            if (!doc.permissions || false !== doc.permissions.download || false !== doc.permissions.print) {
              isValidJwt = true;
              docId = doc.key;
              cmd.setDocId(doc.key);
              userId = decoded.editorConfig?.user?.id;
              cmd.setUserIndex(decoded.editorConfig?.user?.index);
            } else {
              ctx.logger.warn('Error downloadAs jwt: %s', 'access deny');
            }
          } else {
            ctx.logger.warn('Error downloadAs jwt: %s', checkJwtRes.description);
          }
        }
        if (!isValidJwt) {
          res.sendStatus(403);
          return;
        }
      }
      ctx.setDocId(docId);
      ctx.setUserId(userId);
      const selectRes = yield taskResult.select(ctx, docId);
      const row = selectRes.length > 0 ? selectRes[0] : null;
      if (!cmd.getWithoutPassword()) {
        addPasswordToCmd(ctx, cmd, row && row.password, row && row.change_id);
      }
      addOriginFormat(ctx, cmd, row);
      cmd.setData(req.body);
      const outputData = new OutputData(cmd.getCommand());
      switch (cmd.getCommand()) {
        case 'save':
          yield* commandSave(ctx, cmd, outputData);
          break;
        case 'savefromorigin':
          yield* commandSaveFromOrigin(ctx, cmd, outputData, row && row.password);
          break;
        case 'sendmm':
          yield* commandSendMailMerge(ctx, cmd, outputData);
          break;
        default:
          outputData.setStatus('err');
          outputData.setData(constants.UNKNOWN);
          break;
      }
      const strRes = JSON.stringify(outputData);
      res.setHeader('Content-Type', 'application/json');
      res.send(strRes);
      ctx.logger.debug('End downloadAs: %s', strRes);
      if (clientStatsD) {
        clientStatsD.timing('coauth.downloadAs.' + cmd.getCommand(), new Date() - startDate);
      }
    } catch (e) {
      ctx.logger.error('Error downloadAs: %s', e.stack);
      res.sendStatus(400);
    }
  });
};
exports.saveFile = function (req, res) {
  return co(function* () {
    let docId = 'null';
    const ctx = new operationContext.Context();
    try {
      let startDate = null;
      if (clientStatsD) {
        startDate = new Date();
      }
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      const strCmd = req.query['cmd'];
      const cmd = new commonDefines.InputCommand(JSON.parse(strCmd));
      docId = cmd.getDocId();
      ctx.setDocId(docId);
      ctx.logger.debug('Start saveFile');

      let isValidJwt = false;
      const checkJwtRes = yield docsCoServer.checkJwt(ctx, cmd.getTokenSession(), commonDefines.c_oAscSecretType.Session);
      if (checkJwtRes.decoded) {
        const doc = checkJwtRes.decoded.document;
        const edit = checkJwtRes.decoded.editorConfig;
        if (doc.ds_encrypted && !edit.ds_view && !edit.ds_isCloseCoAuthoring) {
          isValidJwt = true;
          docId = doc.key;
          cmd.setDocId(doc.key);
        } else {
          ctx.logger.warn('Error saveFile jwt: %s', 'access deny');
        }
      } else {
        ctx.logger.warn('Error saveFile jwt: %s', checkJwtRes.description);
      }
      if (!isValidJwt) {
        res.sendStatus(403);
        return;
      }
      ctx.setDocId(docId);
      cmd.setStatusInfo(constants.NO_ERROR);
      yield* addRandomKeyTaskCmd(ctx, cmd);
      cmd.setOutputPath(constants.OUTPUT_NAME + pathModule.extname(cmd.getOutputPath()));
      yield storage.putObject(ctx, docId + cmd.getSaveKey() + '/' + cmd.getOutputPath(), req.body, req.body.length);
      const replyStr = yield commandSfcCallback(ctx, cmd, false, true);
      if (replyStr) {
        utils.fillResponseSimple(res, replyStr, 'application/json');
      } else {
        res.sendStatus(400);
      }
      ctx.logger.debug('End saveFile: %s', replyStr);
      if (clientStatsD) {
        clientStatsD.timing('coauth.saveFile', new Date() - startDate);
      }
    } catch (e) {
      ctx.logger.error('Error saveFile: %s', e.stack);
      res.sendStatus(400);
    }
  });
};
function getPrintFileUrl(ctx, docId, baseUrl, filename) {
  return co(function* () {
    const tenTokenSessionAlgorithm = ctx.getCfg('services.CoAuthoring.token.session.algorithm', cfgTokenSessionAlgorithm);
    const tenTokenSessionExpires = ms(ctx.getCfg('services.CoAuthoring.token.session.expires', cfgTokenSessionExpires));

    baseUrl = utils.checkBaseUrl(ctx, baseUrl);
    const payload = {document: {key: docId}};
    const token = yield docsCoServer.signToken(
      ctx,
      payload,
      tenTokenSessionAlgorithm,
      tenTokenSessionExpires / 1000,
      commonDefines.c_oAscSecretType.Session
    );
    //while save printed file Chrome's extension seems to rely on the resource name set in the URI https://stackoverflow.com/a/53593453
    //replace '/' with %2f before encodeURIComponent becase nginx determine %2f as '/' and get wrong system path
    const userFriendlyName = encodeURIComponent(filename.replace(/\//g, '%2f'));
    let res = `${baseUrl}/printfile/${encodeURIComponent(docId)}/${userFriendlyName}?token=${encodeURIComponent(token)}`;
    if (ctx.shardKey) {
      res += `&${constants.SHARD_KEY_API_NAME}=${encodeURIComponent(ctx.shardKey)}`;
    }
    if (ctx.wopiSrc) {
      res += `&${constants.SHARD_KEY_WOPI_NAME}=${encodeURIComponent(ctx.wopiSrc)}`;
    }
    if (ctx.userSessionId) {
      res += `&${constants.USER_SESSION_ID_NAME}=${encodeURIComponent(ctx.userSessionId)}`;
    }
    res += `&filename=${userFriendlyName}`;
    return res;
  });
}
exports.getPrintFileUrl = getPrintFileUrl;
exports.printFile = function (req, res) {
  return co(function* () {
    let docId = 'null';
    const ctx = new operationContext.Context();
    try {
      let startDate = null;
      if (clientStatsD) {
        startDate = new Date();
      }
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      const filename = req.query['filename'];
      const token = req.query['token'];
      docId = req.params.docid;
      ctx.setDocId(docId);
      ctx.logger.info('Start printFile');

      const checkJwtRes = yield docsCoServer.checkJwt(ctx, token, commonDefines.c_oAscSecretType.Session);
      if (checkJwtRes.decoded) {
        const docIdBase = checkJwtRes.decoded.document.key;
        if (!docId.startsWith(docIdBase)) {
          ctx.logger.warn('Error printFile jwt: description = %s', 'access deny');
          res.sendStatus(403);
          return;
        }
      } else {
        ctx.logger.warn('Error printFile jwt: description = %s', checkJwtRes.description);
        res.sendStatus(403);
        return;
      }
      ctx.setDocId(docId);
      const streamObj = yield storage.createReadStream(ctx, `${docId}/${constants.OUTPUT_NAME}.pdf`);
      res.setHeader('Content-Disposition', utils.getContentDisposition(filename, null, constants.CONTENT_DISPOSITION_INLINE));
      res.setHeader('Content-Length', streamObj.contentLength);
      res.setHeader('Content-Type', 'application/pdf');
      yield utils.pipeHttpStreams(streamObj.readStream, res);

      if (clientStatsD) {
        clientStatsD.timing('coauth.printFile', new Date() - startDate);
      }
    } catch (e) {
      ctx.logger.error('Error printFile: %s', e.stack);
      res.sendStatus(400);
    } finally {
      ctx.logger.info('End printFile');
    }
  });
};
/**
 * Proxy download file request to the file storage
 * @param {object} req - The HTTP request object
 * @param {object} res - The HTTP response object
 * @returns {Promise}
 */
exports.downloadFile = function (req, res) {
  return co(function* () {
    const ctx = new operationContext.Context();
    let stream = null;
    try {
      let startDate = null;
      if (clientStatsD) {
        startDate = new Date();
      }

      const docId = req.params.docid;
      if (!docId) {
        res.status(400).send('docid is required');
        return;
      }

      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      ctx.setDocId(docId);

      //todo remove in 8.1. For compatibility
      let url = req.get('x-url');
      if (url) {
        url = decodeURI(url);
      }
      ctx.logger.info('Start downloadFile');
      const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);
      const tenDownloadMaxBytes = ctx.getCfg('FileConverter.converter.maxDownloadBytes', cfgDownloadMaxBytes);
      const tenDownloadTimeout = ctx.getCfg('FileConverter.converter.downloadTimeout', cfgDownloadTimeout);
      const tenDownloadFileAllowExt = ctx.getCfg('services.CoAuthoring.server.downloadFileAllowExt', cfgDownloadFileAllowExt);
      const tenNewFileTemplate = ctx.getCfg('services.CoAuthoring.server.newFileTemplate', cfgNewFileTemplate);

      let authorization;
      let isInJwtToken = false;
      let errorDescription;
      let headers, fromTemplate;
      const authRes = yield docsCoServer.getRequestParams(ctx, req);
      if (authRes.code === constants.NO_ERROR) {
        const decoded = authRes.params;
        if (decoded.changesUrl) {
          url = decoded.changesUrl;
          isInJwtToken = true;
        } else if (decoded.document && -1 !== tenDownloadFileAllowExt.indexOf(decoded.document.fileType)) {
          url = decoded.document.url;
          isInJwtToken = true;
        } else if (decoded.url && -1 !== tenDownloadFileAllowExt.indexOf(decoded.fileType)) {
          url = decoded.url;
          isInJwtToken = true;
        } else if (wopiClient.isWopiJwtToken(decoded)) {
          if (decoded.fileInfo.Size === 0) {
            //editnew case
            fromTemplate = pathModule.extname(decoded.fileInfo.BaseFileName).substring(1);
          } else {
            ({url, headers} = yield wopiUtils.getWopiFileUrl(ctx, decoded.fileInfo, decoded.userAuth));
            const filterStatus = yield wopiClient.checkIpFilter(ctx, url);
            if (0 === filterStatus) {
              //todo false? (true because it passed checkIpFilter for wopi)
              //todo use directIfIn
              isInJwtToken = true;
            } else {
              errorDescription = 'access deny';
            }
          }
        } else if (!tenTokenEnableBrowser) {
          //todo token required
          if (decoded.url) {
            url = decoded.url;
            isInJwtToken = true;
          }
        } else {
          errorDescription = 'access deny';
        }
      } else {
        errorDescription = authRes.description || 'need token';
      }
      if (errorDescription) {
        ctx.logger.warn('Error downloadFile jwt: description = %s', errorDescription);
        res.sendStatus(403);
        return;
      }
      if (fromTemplate) {
        ctx.logger.debug('downloadFile from file template: %s', fromTemplate);
        const locale = constants.TEMPLATES_DEFAULT_LOCALE;
        const fileTemplatePath = pathModule.join(tenNewFileTemplate, locale, 'new.' + fromTemplate);
        res.sendFile(pathModule.resolve(fileTemplatePath));
      } else {
        if (utils.canIncludeOutboxAuthorization(ctx, url)) {
          const secret = yield tenantManager.getTenantSecret(ctx, commonDefines.c_oAscSecretType.Outbox);
          authorization = utils.fillJwtForRequest(ctx, {url}, secret, false);
        }
        const urlParsed = urlModule.parse(url);
        const filterStatus = yield* utils.checkHostFilter(ctx, urlParsed.hostname);
        if (0 !== filterStatus) {
          ctx.logger.warn('Error downloadFile checkIpFilter error: url = %s', url);
          res.sendStatus(filterStatus);
          return;
        }

        if (req.get('Range')) {
          if (!headers) {
            headers = {};
          }
          headers['Range'] = req.get('Range');
        }

        const downloadResult = yield utils.downloadUrlPromise(
          ctx,
          url,
          tenDownloadTimeout,
          tenDownloadMaxBytes,
          authorization,
          isInJwtToken,
          headers,
          true
        );
        const response = downloadResult.response;
        stream = downloadResult.stream;
        // Sanitize Content-Disposition by removing control chars (prevents CRLF/header injection)
        if (response.headers['content-disposition']) {
          response.headers['content-disposition'] = response.headers['content-disposition'].replace(/\p{Cc}/gu, '');
        }
        //Set-Cookie resets browser session
        delete response.headers['set-cookie'];
        // Set the response headers to match the target response
        res.set(response.headers);

        // Use pipeline to pipe the response data to the client
        yield pipeline(stream, res);
      }

      if (clientStatsD) {
        clientStatsD.timing('coauth.downloadFile', new Date() - startDate);
      }
    } catch (err) {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        ctx.logger.debug('Error downloadFile: %s', err.stack);
        if (!res.headersSent) {
          res.sendStatus(499);
        }
      } else {
        ctx.logger.error('Error downloadFile: %s', err.stack);
        //catch errors because status may be sent while piping to response
        if (!res.headersSent) {
          try {
            if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
              res.sendStatus(408);
            } else if (err.code === 'EMSGSIZE') {
              res.sendStatus(413);
            } else if (err.statusCode) {
              res.sendStatus(err.statusCode);
            } else {
              res.sendStatus(400);
            }
          } catch (err) {
            ctx.logger.error('Error downloadFile: %s', err.stack);
          }
        }
      }
    } finally {
      // Ensure stream is properly destroyed
      if (stream && typeof stream.destroy === 'function') {
        try {
          stream.destroy();
        } catch (destroyErr) {
          ctx.logger.warn('Error destroying stream: %s', destroyErr.stack);
        }
      }
      ctx.logger.info('End downloadFile');
    }
  });
};
exports.saveFromChanges = function (ctx, docId, statusInfo, optFormat, opt_userId, opt_userIndex, opt_userLcid, opt_queue, opt_initShardKey) {
  return co(function* () {
    try {
      let startDate = null;
      if (clientStatsD) {
        startDate = new Date();
      }
      ctx.logger.debug('Start saveFromChanges');
      //we do a select, because during the timeout the information could change
      const selectRes = yield taskResult.select(ctx, docId);
      const row = selectRes.length > 0 ? selectRes[0] : null;
      if (row && row.status == commonDefines.FileStatus.SaveVersion && row.status_info == statusInfo) {
        if (null == optFormat) {
          optFormat = changeFormatByOrigin(ctx, row, constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML);
        }
        if (opt_initShardKey) {
          ctx.setShardKey(sqlBase.DocumentAdditional.prototype.getShardKey(row.additional));
          ctx.setWopiSrc(sqlBase.DocumentAdditional.prototype.getWopiSrc(row.additional));
        }
        const cmd = new commonDefines.InputCommand();
        cmd.setCommand('sfc');
        cmd.setDocId(docId);
        cmd.setOutputFormat(optFormat);
        cmd.setStatusInfoIn(statusInfo);
        cmd.setUserActionId(opt_userId);
        cmd.setUserActionIndex(opt_userIndex);
        cmd.appendJsonParams(getOpenedAtJSONParams(row));
        //todo lang and region are different
        cmd.setLCID(opt_userLcid);
        const userAuthStr = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback);
        cmd.setWopiParams(wopiClient.parseWopiCallback(ctx, userAuthStr, row.callback));
        addPasswordToCmd(ctx, cmd, row && row.password, row && row.change_id);
        addOriginFormat(ctx, cmd, row);
        yield* addRandomKeyTaskCmd(ctx, cmd);
        const queueData = getSaveTask(ctx, cmd);
        queueData.setFromChanges(true);
        yield* docsCoServer.addTask(queueData, constants.QUEUE_PRIORITY_NORMAL, opt_queue);
        if (docsCoServer.getIsShutdown()) {
          yield docsCoServer.editorStat.addShutdown(redisKeyShutdown, docId);
        }
        ctx.logger.debug('AddTask saveFromChanges');
      } else {
        if (row) {
          ctx.logger.debug('saveFromChanges status mismatch: row: %d; %d; expected: %d', row.status, row.status_info, statusInfo);
        }
      }
      if (clientStatsD) {
        clientStatsD.timing('coauth.saveFromChanges', new Date() - startDate);
      }
    } catch (e) {
      ctx.logger.error('Error saveFromChanges: %s', e.stack);
    }
  });
};

async function processWopiSaveAs(ctx, cmd) {
  let res;
  const info = await docsCoServer.getCallback(ctx, cmd.getDocId(), cmd.getUserIndex());
  // info.wopiParams is null if it is not wopi
  if (info?.wopiParams) {
    const suggestedExt = `.${formatChecker.getStringFromFormat(cmd.getOutputFormat())}`;
    const suggestedTarget = cmd.getSaveAsPath();
    const storageFilePath = `${cmd.getDocId()}${cmd.getSaveKey()}/${cmd.getOutputPath()}`;
    const stream = await storage.createReadStream(ctx, storageFilePath);
    const {wopiSrc, access_token} = info.wopiParams.userAuth;
    res = await wopiClient.putRelativeFile(
      ctx,
      wopiSrc,
      access_token,
      null,
      stream.readStream,
      stream.contentLength,
      suggestedExt,
      suggestedTarget,
      false
    );
  }
  return {res, wopiParams: info?.wopiParams};
}
// opt_isDeliveryLive tells whether the broker still holds the delivery for this
// consumer (false once the channel that delivered it is gone).
exports.receiveTask = function (data, ack, opt_isDeliveryLive) {
  return co(function* () {
    const ctx = new operationContext.Context();
    let task;
    let shouldAck = true;
    try {
      task = new commonDefines.TaskQueueData(JSON.parse(data));
      if (task) {
        const cmd = task.getCmd();
        ctx.initFromTaskQueueData(task);
        yield ctx.initTenantCache();
        ctx.logger.info('receiveTask start: %s', data);
        const updateTask = yield getUpdateResponse(ctx, cmd);
        const updateRes = yield taskResult.update(ctx, updateTask);
        if (updateRes.affectedRows > 0) {
          const outputData = new OutputData(cmd.getCommand());
          const command = cmd.getCommand();
          const additionalOutput = {
            needUrlKey: null,
            needUrlMethod: null,
            needUrlType: null,
            needUrlIsCorrectPassword: undefined,
            creationDate: undefined,
            openedAt: undefined,
            row: undefined
          };
          if ('open' === command || 'reopen' === command) {
            yield getOutputData(ctx, cmd, outputData, cmd.getDocId(), null, additionalOutput);
            //wopi from TemplateSource
            if (additionalOutput.row) {
              const row = additionalOutput.row;
              const userAuthStr = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback);
              const wopiParams = wopiClient.parseWopiCallback(ctx, userAuthStr, row.callback);
              if (wopiParams?.commonInfo?.fileInfo?.TemplateSource) {
                ctx.logger.debug('receiveTask: save document opened from TemplateSource');
                //todo
                //no need to wait to open file faster
                void docsCoServer.startForceSave(
                  ctx,
                  cmd.getDocId(),
                  commonDefines.c_oAscForceSaveTypes.Timeout,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  row.baseurl,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  cmd.getExternalChangeInfo()
                );
              }
            }
          } else if ('save' === command || 'savefromorigin' === command) {
            const status = yield getOutputData(ctx, cmd, outputData, cmd.getDocId() + cmd.getSaveKey(), null, additionalOutput);
            if (commonDefines.FileStatus.Ok === status && (cmd.getSaveAsPath() || cmd.getIsSaveAs())) {
              //todo in case of wopi no need to send url. send it to avoid stubs in sdk
              const saveAsRes = yield processWopiSaveAs(ctx, cmd);
              if (!saveAsRes.res && saveAsRes.wopiParams) {
                outputData.setStatus('err');
                outputData.setData(constants.CONVERT);
                additionalOutput.needUrlKey = null;
              }
            }
          } else if ('sfcm' === command) {
            yield commandSfcCallback(ctx, cmd, true);
          } else if ('sfc' === command) {
            yield commandSfcCallback(ctx, cmd, false, undefined, opt_isDeliveryLive);
          } else if ('sendmm' === command) {
            yield* commandSendMMCallback(ctx, cmd);
          } else if ('conv' === command) {
            //nothing
          }
          if (outputData.getStatus()) {
            ctx.logger.debug('receiveTask publish: %s', JSON.stringify(outputData));
            const output = new OutputDataWrap('documentOpen', outputData);
            yield docsCoServer.publish(ctx, {
              type: commonDefines.c_oPublishType.receiveTask,
              ctx,
              cmd,
              output,
              needUrlKey: additionalOutput.needUrlKey,
              needUrlMethod: additionalOutput.needUrlMethod,
              needUrlType: additionalOutput.needUrlType,
              needUrlIsCorrectPassword: additionalOutput.needUrlIsCorrectPassword,
              creationDate: additionalOutput.creationDate,
              openedAt: additionalOutput.openedAt
            });
          }
        }
      }
    } catch (err) {
      ctx.logger.error('receiveTask error: %s', err.stack);
      const cmd = task && task.getCmd();
      if (cmd && 'sfc' === cmd.getCommand()) {
        shouldAck = yield* scheduleSfcRetryUntilConfirmed(ctx, cmd, opt_isDeliveryLive);
      }
    } finally {
      ctx.logger.info('receiveTask end');
      if (shouldAck) {
        ack();
      }
    }
  });
};

exports.cleanupCache = cleanupCache;
exports.isUpdateVersionExpired = isUpdateVersionExpired;
exports.isFinalSaveInProgress = isFinalSaveInProgress;
exports.getSfcInfraRetryDelay = getSfcInfraRetryDelay;
exports.takeOverAbandonedSaveForOpen = co.wrap(takeOverAbandonedSaveForOpen);
exports.isSfcRetryBudgetExhausted = isSfcRetryBudgetExhausted;
exports.taskResultMatchesMask = taskResultMatchesMask;
exports.abandonSfcRetry = co.wrap(abandonSfcRetry);
exports.cleanupCacheIf = cleanupCacheIf;
exports.cleanupErrToReload = cleanupErrToReload;
exports.getOpenedAt = getOpenedAt;
exports.commandSfctByCmd = commandSfctByCmd;
exports.commandOpenStartPromise = commandOpenStartPromise;
exports.commandPathUrls = commandPathUrls;
exports.commandSfcCallback = commandSfcCallback;
exports.OutputDataWrap = OutputDataWrap;
exports.OutputData = OutputData;
