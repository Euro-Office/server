'use strict';

const crypto = require('crypto');
const {
  EditorCommon,
  cfgExpPresence,
  cfgExpMonthUniqueUsers,
  ttlSeconds,
  ttlMilliseconds,
  encodePart,
  toRedisString,
  jsonEncode,
  jsonDecode,
  decodeHash,
  strictMax,
  ADD_MONTH_USER_SCRIPT,
  ADD_UNIQUE_USER_SCRIPT,
  GET_UNIQUE_USERS_SCRIPT,
  SET_CONNECTION_SAMPLE_SCRIPT,
  SET_SHARD_COUNT_SCRIPT,
  INCR_SHARD_COUNT_SCRIPT,
  GET_SHARD_COUNT_SCRIPT
} = require('./base');

function EditorStat(database) {
  EditorCommon.call(this, database);
  this.sampleId = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  this.sampleSequence = 0;
}

EditorStat.prototype = Object.create(EditorCommon.prototype);
EditorStat.prototype.constructor = EditorStat;

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

EditorStat.prototype.setEditorConnections = async function (ctx, countEdit, countLiveView, countView, now, precision) {
  const maxAge = precision[precision.length - 1].val;
  const data = {time: now, edit: countEdit, liveview: countLiveView, view: countView};
  const member = jsonEncode({
    id: `${this.sampleId}:${this.sampleSequence++}`,
    data
  });
  await this._eval(SET_CONNECTION_SAMPLE_SCRIPT, [`${this._statBase(ctx)}editorconnections`], [String(now), member, strictMax(now - maxAge + 1)]);
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
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
  const keys = this._shardKeys(ctx, type);
  return this._eval(SET_SHARD_COUNT_SCRIPT, [keys.count, keys.updated], [String(shardId), String(count), String(Date.now()), String(ttl)]);
};

EditorStat.prototype._incrShardCount = async function (ctx, type, shardId, count) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
  const keys = this._shardKeys(ctx, type);
  return this._eval(INCR_SHARD_COUNT_SCRIPT, [keys.count, keys.updated], [String(shardId), String(count), String(Date.now()), String(ttl)]);
};

EditorStat.prototype._getShardCount = async function (ctx, type) {
  const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.presence', cfgExpPresence);
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

module.exports = EditorStat;
