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
      // notificationService sends 99% of repeatInterval in whole seconds: 0
      // for an interval of about a second or less, which locks for 1 ms (the
      // notification is sent every time), as the in-memory backend does.
      const ttlMs = Number(ttl) > 0 ? ttlMilliseconds(ttl) : 1;
      const result = await this._command(['SET', key, '1', 'NX', 'PX', String(ttlMs)]);
      return result === 'OK';
    } catch (_error) {
      return false;
    }
  };

  EditorStat.prototype.deleteKey = async function (key) {
    await this._command(['DEL', key]);
  };
};
