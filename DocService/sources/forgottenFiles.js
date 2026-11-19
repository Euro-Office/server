/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Forgotten files of a document: the regular file (<forgottenfilesname>.<ext>) holds a save that did not reach
// the host and is opened as the document; the partial output of a CONVERT_CORRUPTED save
// (<forgottenfilesname>-partial.<ext>) is held back and only deleteForgotten removes it.

const config = require('config');
const storage = require('./../../Common/sources/storage/storage-base');
const utils = require('./../../Common/sources/utils');

const cfgForgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
const cfgForgottenFilesName = config.get('services.CoAuthoring.server.forgottenfilesname');

/**
 * Whether closing the last editor has to start a save.
 * Without changes, a regular forgotten file still has to be saved.
 * The partial output of a CONVERT_CORRUPTED save is not the opened document, so it does not start a save.
 * @param ctx Local context.
 * @param {string} docId Document id.
 * @param {boolean} hasChanges Whether the document has changes that are not saved yet.
 * @returns {Promise<boolean>}
 */
async function needSaveOnClose(ctx, docId, hasChanges) {
  if (hasChanges) {
    return true;
  }
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  const tenForgottenFilesName = ctx.getCfg('services.CoAuthoring.server.forgottenfilesname', cfgForgottenFilesName);
  //start save changes if forgotten file exists.
  //more effective to send file without sfc, but this method is simpler by code
  const forgotten = await storage.listObjects(ctx, docId, tenForgottenFiles);
  const hasForgotten = utils.getForgottenRegular(forgotten, tenForgottenFilesName).length > 0;
  ctx.logger.debug('closeDocument hasForgotten %s', hasForgotten);
  return hasForgotten;
}

/**
 * Deletes the forgotten files of a document after its changes were saved.
 * The partial output of a CONVERT_CORRUPTED save is kept: the save started from the host file, so it does not
 * contain the edits of that output. Only deleteForgotten removes it.
 * @param ctx Local context.
 * @param {string} docId Document id.
 */
async function deleteForgottenAfterSave(ctx, docId) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  const tenForgottenFilesName = ctx.getCfg('services.CoAuthoring.server.forgottenfilesname', cfgForgottenFilesName);

  const forgottenList = await storage.listObjects(ctx, docId, tenForgottenFiles);
  const regularList = utils.getForgottenRegular(forgottenList, tenForgottenFilesName);
  if (regularList.length === forgottenList.length) {
    await storage.deletePath(ctx, docId, tenForgottenFiles);
  } else {
    await Promise.all(regularList.map(forgotten => storage.deleteObject(ctx, forgotten, tenForgottenFiles)));
  }
}

module.exports = {needSaveOnClose, deleteForgottenAfterSave};
