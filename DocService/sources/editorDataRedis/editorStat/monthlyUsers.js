/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {ADD_MONTH_USER_SCRIPT} = require('../scripts');
const {encodePart} = require('../redisKeys');
const {cfgExpMonthUniqueUsers} = require('../editorStatSettings');
const {jsonEncode, toRedisString, decodeHash} = require('../redisValueCodec');

module.exports = function attachMonthlyUsers(EditorStat) {
  EditorStat.prototype._monthIndexKey = function (ctx, view) {
    return `${this._statBase(ctx)}presence:month:${view ? 'view' : 'edit'}:index`;
  };

  EditorStat.prototype._monthDataKey = function (ctx, period, view) {
    return `${this._statBase(ctx)}presence:month:${view ? 'view' : 'edit'}:${encodePart(period)}`;
  };

  EditorStat.prototype._addMonthUser = async function (ctx, userId, period, userInfo, view) {
    const now = Date.now();
    const duration = Number(cfgExpMonthUniqueUsers);
    const index = this._monthIndexKey(ctx, view);
    const data = this._monthDataKey(ctx, period, view);
    await this._eval(
      ADD_MONTH_USER_SCRIPT,
      [index, data],
      [String(now + duration), String(period), String(duration), String(userId), jsonEncode(userInfo)]
    );
  };

  EditorStat.prototype._getMonthUsers = async function (ctx, view) {
    const index = this._monthIndexKey(ctx, view);
    const now = Date.now();
    await this._command(['ZREMRANGEBYSCORE', index, '-inf', String(now)]);
    const periods = await this._command(['ZRANGEBYSCORE', index, String(now + 1), '+inf']);
    const values = periods?.length
      ? await this._commands((periods || []).map(period => ['HGETALL', this._monthDataKey(ctx, toRedisString(period), view)]))
      : [];
    const result = {};
    for (const [index, periodValue] of (periods || []).entries()) {
      const period = toRedisString(periodValue);
      const users = decodeHash(values[index]);
      if (Object.keys(users).length > 0) {
        const time = Number(period);
        if (Number.isFinite(time)) {
          result[new Date(time).toISOString()] = users;
        }
      }
    }
    return result;
  };

  for (const [suffix, view] of [
    ['', false],
    ['View', true]
  ]) {
    EditorStat.prototype[`addPresenceUnique${suffix}UsersOfMonth`] = async function (ctx, userId, period, userInfo) {
      return this._addMonthUser(ctx, userId, period, userInfo, view);
    };
    EditorStat.prototype[`getPresenceUnique${suffix}UsersOfMonth`] = async function (ctx) {
      return this._getMonthUsers(ctx, view);
    };
  }
};
