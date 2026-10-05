/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {SET_CONNECTION_SAMPLE_SCRIPT, SET_SHARD_COUNT_SCRIPT, INCR_SHARD_COUNT_SCRIPT, GET_SHARD_COUNT_SCRIPT} = require('../scripts');
const {cfgExpShard} = require('../editorStatSettings');
const {ttlSeconds, jsonEncode, jsonDecode, strictMax} = require('../redisValueCodec');

module.exports = function attachConnections(EditorStat) {
  EditorStat.prototype.setEditorConnections = async function (ctx, countEdit, countLiveView, countView, now, precision) {
    const maxAge = precision[precision.length - 1].val;
    const data = {time: now, edit: countEdit, liveview: countLiveView, view: countView};
    const member = jsonEncode({
      id: `${this.sampleId}:${this.sampleSequence++}`,
      data
    });
    await this._eval(
      SET_CONNECTION_SAMPLE_SCRIPT,
      [`${this._statBase(ctx)}editorconnections`],
      [String(now), member, strictMax(now - maxAge + 1), String(maxAge)]
    );
  };

  EditorStat.prototype.getEditorConnections = async function (ctx) {
    const values = await this._command(['ZRANGE', `${this._statBase(ctx)}editorconnections`, '0', '-1']);
    const result = [];
    for (const value of values || []) {
      const parsed = jsonDecode(value, null);
      if (parsed && parsed.data) {
        result.push(parsed.data);
      }
    }
    return result;
  };

  EditorStat.prototype._shardKeys = function (ctx, type) {
    const base = `${this._statBase(ctx)}connections:${type}`;
    return {
      count: `${base}:count`,
      updated: `${base}:updated`
    };
  };

  EditorStat.prototype._setShardCount = async function (ctx, type, shardId, count) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.shard', cfgExpShard);
    const keys = this._shardKeys(ctx, type);
    return this._eval(SET_SHARD_COUNT_SCRIPT, [keys.count, keys.updated], [String(shardId), String(count), String(Date.now()), String(ttl)]);
  };

  EditorStat.prototype._incrShardCount = async function (ctx, type, shardId, count) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.shard', cfgExpShard);
    const keys = this._shardKeys(ctx, type);
    return this._eval(INCR_SHARD_COUNT_SCRIPT, [keys.count, keys.updated], [String(shardId), String(count), String(Date.now()), String(ttl)]);
  };

  EditorStat.prototype._getShardCount = async function (ctx, type) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.shard', cfgExpShard);
    const keys = this._shardKeys(ctx, type);
    const result = await this._eval(GET_SHARD_COUNT_SCRIPT, [keys.count, keys.updated], [String(Date.now() - ttl * 1000)]);
    return Number(result) || 0;
  };

  for (const [name, type] of [
    ['Editor', 'edit'],
    ['Viewer', 'view'],
    ['LiveViewer', 'liveview']
  ]) {
    EditorStat.prototype[`set${name}ConnectionsCountByShard`] = async function (ctx, shardId, count) {
      return this._setShardCount(ctx, type, shardId, count);
    };
    EditorStat.prototype[`incr${name}ConnectionsCountByShard`] = async function (ctx, shardId, count) {
      return this._incrShardCount(ctx, type, shardId, count);
    };
    EditorStat.prototype[`get${name}ConnectionsCount`] = async function (ctx, _connections) {
      return this._getShardCount(ctx, type);
    };
  }
};
