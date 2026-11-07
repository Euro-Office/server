/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {ttlMilliseconds} = require('../redisValueCodec');
const {encodePart} = require('../redisKeys');

module.exports = function attachHousekeeping(EditorStat) {
  EditorStat.prototype.addShutdown = async function (key, docId) {
    await this._command(['SADD', key, String(docId)]);
  };

  EditorStat.prototype.removeShutdown = async function (key, docId) {
    await this._command(['SREM', key, String(docId)]);
  };

  EditorStat.prototype.getShutdownCount = async function (key) {
    return Number(await this._command(['SCARD', key]));
  };

  EditorStat.prototype.cleanupShutdown = async function (key) {
    await this._command(['DEL', key]);
  };

  EditorStat.prototype.setLicense = async function (key, val) {
    await this._command(['HSET', key, key, String(val)]);
  };

  EditorStat.prototype.getLicense = async function (key) {
    return this._command(['HGET', key, key]);
  };

  EditorStat.prototype.removeLicense = async function (key) {
    await this._command(['HDEL', key, key]);
  };

  EditorStat.prototype.lockNotification = async function (ctx, notificationType, ttl) {
    const key = `${this._statBase(ctx)}notification:${encodePart(notificationType)}`;
    try {
      const result = await this._command(['SET', key, '1', 'NX', 'PX', String(ttlMilliseconds(ttl))]);
      return result === 'OK';
    } catch (_error) {
      return false;
    }
  };

  EditorStat.prototype.deleteKey = async function (key) {
    await this._command(['DEL', key]);
  };
};
