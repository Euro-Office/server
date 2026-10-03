/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {ADD_UNIQUE_USER_SCRIPT, GET_UNIQUE_USERS_SCRIPT} = require('../scripts');
const {toRedisString, jsonEncode, jsonDecode} = require('../redisValueCodec');

module.exports = function attachUniqueUsers(EditorStat) {
  EditorStat.prototype._uniqueKeys = function (ctx, view) {
    const base = this._statBase(ctx);
    const suffix = view ? 'view' : 'edit';
    return {
      expiry: `${base}presence:unique:${suffix}:expiry`,
      info: `${base}presence:unique:${suffix}:info`
    };
  };

  EditorStat.prototype._addUniqueUser = async function (ctx, userId, expireAt, userInfo, view) {
    const keys = this._uniqueKeys(ctx, view);
    await this._eval(ADD_UNIQUE_USER_SCRIPT, [keys.expiry, keys.info], [String(expireAt), String(userId), jsonEncode(userInfo)]);
  };

  EditorStat.prototype._getUniqueUsers = async function (ctx, nowUTC, view) {
    const keys = this._uniqueKeys(ctx, view);
    const result = await this._eval(GET_UNIQUE_USERS_SCRIPT, [keys.expiry, keys.info], [String(nowUTC)]);
    const users = [];
    for (let i = 0; i + 2 < (result || []).length; i += 3) {
      const userInfo = jsonDecode(result[i + 2], {});
      users.push({
        userid: toRedisString(result[i]),
        expire: new Date(Number(result[i + 1]) * 1000),
        ...userInfo
      });
    }
    return users;
  };

  for (const [suffix, view] of [
    ['', false],
    ['View', true]
  ]) {
    EditorStat.prototype[`addPresenceUnique${suffix}User`] = async function (ctx, userId, expireAt, userInfo) {
      return this._addUniqueUser(ctx, userId, expireAt, userInfo, view);
    };
    EditorStat.prototype[`getPresenceUnique${suffix}User`] = async function (ctx, nowUTC) {
      return this._getUniqueUsers(ctx, nowUTC, view);
    };
  }
};
