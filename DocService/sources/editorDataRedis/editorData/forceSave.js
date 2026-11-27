/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {FORCE_SAVE_FIELDS, START_FORCE_SAVE_SCRIPT, SET_FORCE_SAVE_SCRIPT, STORE_FORCE_SAVE_SCRIPT} = require('../scripts');
const {cfgExpForceSave} = require('../editorDataSettings');
const {ttlSeconds, jsonEncode, jsonDecode, toRedisString} = require('../redisValueCodec');

function decodeForceSavePayload(raw, defined) {
  return toRedisString(defined) === '1' ? jsonDecode(raw, null) : undefined;
}

function decodeForceSave(result, fallback) {
  if (!result || result[0] === null || result[0] === undefined) {
    return fallback;
  }
  return {
    time: jsonDecode(result[0], undefined),
    index: jsonDecode(result[1], undefined),
    baseUrl: decodeForceSavePayload(result[2], result[3]),
    changeInfo: decodeForceSavePayload(result[4], result[5]),
    convertInfo: decodeForceSavePayload(result[6], result[7]),
    started: toRedisString(result[8]) === '1',
    ended: toRedisString(result[9]) === '1'
  };
}

module.exports = function attachForceSave(EditorData) {
  EditorData.prototype.setForceSave = async function (ctx, docId, time, index, baseUrl, changeInfo, convertInfo) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
    const key = this._docKeys(ctx, docId).forceSave;
    await this._eval(
      STORE_FORCE_SAVE_SCRIPT,
      [key],
      [
        jsonEncode(time),
        jsonEncode(index),
        jsonEncode(baseUrl),
        baseUrl === undefined ? '0' : '1',
        changeInfo === undefined ? '' : jsonEncode(changeInfo),
        changeInfo === undefined ? '0' : '1',
        convertInfo === undefined ? '' : jsonEncode(convertInfo),
        convertInfo === undefined ? '0' : '1',
        String(ttl)
      ]
    );
  };

  EditorData.prototype.getForceSave = async function (ctx, docId) {
    const result = await this._command(['HMGET', this._docKeys(ctx, docId).forceSave, ...FORCE_SAVE_FIELDS]);
    return decodeForceSave(result, null);
  };

  EditorData.prototype.checkAndStartForceSave = async function (ctx, docId) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
    const result = await this._eval(START_FORCE_SAVE_SCRIPT, [this._docKeys(ctx, docId).forceSave], [String(ttl)]);
    return decodeForceSave(result, undefined);
  };

  EditorData.prototype.checkAndSetForceSave = async function (ctx, docId, time, index, started, ended, convertInfo) {
    const hasConvertInfo = convertInfo !== undefined;
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.forcesave', cfgExpForceSave);
    const result = await this._eval(
      SET_FORCE_SAVE_SCRIPT,
      [this._docKeys(ctx, docId).forceSave],
      [
        jsonEncode(time),
        jsonEncode(index),
        started ? '1' : '0',
        ended ? '1' : '0',
        hasConvertInfo ? '1' : '0',
        hasConvertInfo ? jsonEncode(convertInfo) : '',
        String(ttl)
      ]
    );
    return decodeForceSave(result, undefined);
  };

  EditorData.prototype.removeForceSave = async function (ctx, docId) {
    await this._command(['DEL', this._docKeys(ctx, docId).forceSave]);
  };
};
