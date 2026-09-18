/*
 * (c) Copyright Ascensio System SIA 2010-2025
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the AGPL its Section 15 shall be amended to the effect that
 * Ascensio System SIA expressly excludes the warranty of non-infringement of
 * any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * The interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International.
 */

'use strict';

const config = require('config');
const ms = require('ms');
const redis = require('redis');

const commonDefines = require('./../../../Common/sources/commondefines');
const operationContext = require('./../../../Common/sources/operationContext');
const {
  LOCK_SCRIPT,
  UNLOCK_SCRIPT,
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  REMOVE_DOCUMENT_INDEX_SCRIPT,
  POP_EXPIRED_SCRIPT,
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT,
  ADD_MESSAGE_SCRIPT,
  GETDEL_SCRIPT,
  START_FORCE_SAVE_SCRIPT,
  SET_FORCE_SAVE_SCRIPT,
  STORE_FORCE_SAVE_SCRIPT,
  ADD_MONTH_USER_SCRIPT,
  ADD_UNIQUE_USER_SCRIPT,
  GET_UNIQUE_USERS_SCRIPT,
  SET_CONNECTION_SAMPLE_SCRIPT,
  SET_SHARD_COUNT_SCRIPT,
  INCR_SHARD_COUNT_SCRIPT,
  GET_SHARD_COUNT_SCRIPT,
  CLEAN_DOCUMENT_SCRIPT
} = require('./scripts');

const REDIS_LOG_PREFIX = '[editorDataRedis]';
const REDIS_CONNECT_TIMEOUT_MS = 15000;
const REDIS_COMMAND_TIMEOUT_MS = 30000;

const cfgRedis = config.get('services.CoAuthoring.redis');
const cfgRedisName = cfgRedis.get('name');
const cfgRedisPrefix = cfgRedis.get('prefix');
const cfgRedisHost = cfgRedis.get('host');
const cfgRedisPort = cfgRedis.get('port');
const cfgRedisOptions = cfgRedis.get('options');
const cfgRedisOptionsCluster = cfgRedis.get('optionsCluster');

const cfgExpPresence = config.get('services.CoAuthoring.expire.presence');
const cfgExpLocks = config.get('services.CoAuthoring.expire.locks');
const cfgExpMessage = config.get('services.CoAuthoring.expire.message');
const cfgExpForceSave = config.get('services.CoAuthoring.expire.forcesave');
const cfgExpSaved = config.get('services.CoAuthoring.expire.saved');
const cfgExpMonthUniqueUsers = ms(config.get('services.CoAuthoring.expire.monthUniqueUsers'));

function cloneConfig(value) {
  if (config.util && config.util.cloneDeep) {
    return config.util.cloneDeep(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeNodeOptions(source, database) {
  const options = cloneConfig(source) || {};
  if (options.user !== undefined && options.username === undefined) {
    options.username = options.user;
  }
  if (options.db !== undefined && options.database === undefined) {
    options.database = options.db;
  }
  delete options.user;
  delete options.db;
  if (options.database !== undefined && options.database !== null && options.database !== '') {
    options.database = Number(options.database);
  }
  if (database !== undefined && database !== null && database !== '') {
    options.database = Number(database);
  }
  if (!options.url) {
    options.socket = options.socket || {};
    if (options.socket.host === undefined) {
      options.socket.host = cfgRedisHost;
    }
    if (options.socket.port === undefined) {
      options.socket.port = Number(cfgRedisPort);
    }
  }
  return options;
}

function normalizeClusterOptions(source) {
  const options = cloneConfig(source) || {};
  options.defaults = normalizeNodeOptions(options.defaults || {});
  delete options.defaults.socket;
  delete options.defaults.database;
  return options;
}

function hasNodeCluster() {
  const options = cloneConfig(cfgRedisOptionsCluster) || {};
  return Array.isArray(options.rootNodes) && options.rootNodes.length > 0;
}

function toRedisString(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return String(value);
}

function encodePart(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function tenantName(ctx) {
  return ctx && ctx.tenant !== undefined && ctx.tenant !== null ? String(ctx.tenant) : '';
}

function documentMember(ctx, docId) {
  return JSON.stringify([tenantName(ctx), String(docId)]);
}

function decodeDocumentMember(value) {
  try {
    const parsed = JSON.parse(toRedisString(value));
    return Array.isArray(parsed) && parsed.length === 2 ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function getCfg(ctx, path, fallback) {
  return ctx && typeof ctx.getCfg === 'function' ? ctx.getCfg(path, fallback) : fallback;
}

function ttlSeconds(ctx, path, fallback) {
  const value = getCfg(ctx, path, fallback);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.ceil(numeric));
  }
  return Math.max(1, Math.ceil(ms(value) / 1000));
}

function ttlMilliseconds(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.ceil(numeric * 1000));
  }
  return Math.max(1, Math.ceil(ms(value)));
}

function jsonEncode(value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function jsonDecode(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(toRedisString(value));
  } catch (_e) {
    return fallback;
  }
}

function pairsToObject(value) {
  if (!value) {
    return {};
  }
  if (!Array.isArray(value)) {
    return value;
  }
  const result = {};
  for (let i = 0; i + 1 < value.length; i += 2) {
    result[toRedisString(value[i])] = value[i + 1];
  }
  return result;
}

function decodeHash(value) {
  const raw = pairsToObject(value);
  const result = {};
  for (const field in raw) {
    if (Object.hasOwn(raw, field)) {
      result[field] = jsonDecode(raw[field], null);
    }
  }
  return result;
}

function argsFromObject(value) {
  const result = [];
  for (const field in value) {
    if (Object.hasOwn(value, field)) {
      result.push(field, jsonEncode(value[field]));
    }
  }
  return result;
}

function strictMax(now) {
  return String(Math.ceil(Number(now)) - 1);
}

function getLogger() {
  return operationContext.global && operationContext.global.logger ? operationContext.global.logger : console;
}

function log(level, message, ...args) {
  try {
    const logger = getLogger();
    const method = typeof logger[level] === 'function' ? logger[level] : logger.error;
    method.call(logger, `${REDIS_LOG_PREFIX} ${message}`, ...args);
  } catch (_e) {
    // Logging must never prevent Redis cleanup or recovery.
  }
}

function errorDetails(error) {
  if (!error) {
    return 'unknown error';
  }
  return error.stack || `${error.name || 'Error'}: ${error.message || String(error)}`;
}

function withTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${description} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForReady(client, connector, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const readyEvent = 'ready';
    const endEvent = 'end';
    const onReady = () => finish(null);
    const onEnd = () => finish(new Error(`Redis ${connector} connection ended before becoming ready`));
    const onError = error => finish(error instanceof Error ? error : new Error(String(error)));
    const timer = setTimeout(() => finish(new Error(`Redis ${connector} did not become ready within ${timeoutMs}ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener(readyEvent, onReady);
      client.removeListener(endEvent, onEnd);
      client.removeListener('error', onError);
    };
    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }
    client.once(readyEvent, onReady);
    client.once(endEvent, onEnd);
    client.once('error', onError);
  });
}

class RedisConnection {
  constructor(database) {
    this.database = database;
    this.client = null;
    this.connectPromise = null;
    this.connector = null;
    this.cluster = false;
    this.commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS;
  }

  _createClient() {
    if (cfgRedisName !== 'redis') {
      log('error', 'unsupported Redis connector configured: %s', cfgRedisName);
      throw new Error(`Unsupported Redis connector: ${cfgRedisName}`);
    }
    this.connector = 'redis';
    this.cluster = hasNodeCluster();
    if (this.cluster) {
      if (this.database !== undefined && this.database !== null && Number(this.database) !== 0) {
        log('error', 'Redis Cluster cannot use logical database %s; configure database 0', this.database);
        throw new Error('Redis Cluster does not support a non-zero logical database');
      }
      this.client = redis.createCluster(normalizeClusterOptions(cfgRedisOptionsCluster));
    } else {
      this.client = redis.createClient(normalizeNodeOptions(cfgRedisOptions, this.database));
    }
    log(
      'debug',
      'created %s client (cluster=%s, host=%s, port=%s, database=%s)',
      this.connector,
      this.cluster,
      cfgRedisHost,
      cfgRedisPort,
      this.database ?? 0
    );
    this.client.on('error', error => {
      log('error', 'client error (connector=%s, cluster=%s): %s', this.connector, this.cluster, errorDetails(error));
    });
    this.client.on('reconnecting', details => {
      log('warn', 'client reconnecting (connector=%s): %j', this.connector, details || {});
    });
  }

  async connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.isConnected()) {
      return;
    }
    if (!this.client) {
      this._createClient();
    }
    const currentClient = this.client;
    const startedAt = Date.now();
    log(
      'debug',
      'connect start (connector=%s, status=%s, open=%s, ready=%s)',
      this.connector,
      currentClient.status || 'n/a',
      currentClient.isOpen ?? 'n/a',
      currentClient.isReady ?? 'n/a'
    );
    this.connectPromise = (async () => {
      if (!currentClient.isOpen) {
        await withTimeout(currentClient.connect(), REDIS_CONNECT_TIMEOUT_MS, 'Redis connect');
      }
      if (!this.cluster && !currentClient.isReady) {
        await waitForReady(currentClient, this.connector, REDIS_CONNECT_TIMEOUT_MS);
      }
    })();
    try {
      await this.connectPromise;
      log('debug', 'connect ready after %dms (connector=%s)', Date.now() - startedAt, this.connector);
    } catch (error) {
      log(
        'error',
        'connect failed after %dms (connector=%s, host=%s, port=%s, database=%s): %s',
        Date.now() - startedAt,
        this.connector,
        cfgRedisHost,
        cfgRedisPort,
        this.database ?? 0,
        errorDetails(error)
      );
      await this.close();
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  isConnected() {
    if (!this.client) {
      return false;
    }
    return this.cluster ? Boolean(this.client.isOpen) : Boolean(this.client.isReady);
  }

  async command(args) {
    await this.connect();
    const normalized = args.map(toRedisString);
    const commandName = normalized[0] ? normalized[0].toUpperCase() : 'UNKNOWN';
    const startedAt = Date.now();
    log('debug', 'command start %s (keys=%d)', commandName, Math.max(0, normalized.length - 1));
    let result;
    try {
      if (this.cluster) {
        const command = normalized[0].toUpperCase();
        const firstKey = command === 'EVAL' ? normalized[3] : command === 'PING' ? undefined : normalized[1];
        result = this.client.sendCommand(firstKey, false, normalized);
      } else {
        result = this.client.sendCommand(normalized);
      }
      result = await this._withCommandTimeout(result, `Redis command ${commandName}`);
      log('debug', 'command end %s after %dms', commandName, Date.now() - startedAt);
      return result;
    } catch (error) {
      log('error', 'command failed %s after %dms (connector=%s): %s', commandName, Date.now() - startedAt, this.connector, errorDetails(error));
      throw error;
    }
  }

  async commands(commands) {
    if (this.cluster) {
      return Promise.all(commands.map(command => this.command(command)));
    }
    await this.connect();
    const multi = this.client.multi();
    for (const args of commands) {
      multi.addCommand(args.map(toRedisString));
    }
    return this._withCommandTimeout(multi.exec(), `Redis transaction with ${commands.length} commands`);
  }

  async eval(script, keys, args) {
    return this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    if (!client) {
      return;
    }
    if (client.isOpen) {
      try {
        log('debug', 'closing redis client');
        await withTimeout(client.quit(), 5000, 'Redis quit');
      } catch (error) {
        log('warn', 'graceful Redis close failed; forcing disconnect: %s', errorDetails(error));
        if (typeof client.destroy === 'function') {
          client.destroy();
        } else if (typeof client.disconnect === 'function') {
          client.disconnect();
        }
      }
    }
  }

  _abortClient() {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    if (!client) {
      return;
    }
    if (typeof client.destroy === 'function') {
      client.destroy();
    } else if (typeof client.disconnect === 'function') {
      client.disconnect();
    }
  }

  async _withCommandTimeout(promise, description) {
    try {
      return await withTimeout(promise, this.commandTimeoutMs, description);
    } catch (error) {
      if (error.code === 'ETIMEDOUT') {
        this._abortClient();
      }
      throw error;
    }
  }
}

function EditorCommon(database) {
  this.redis = new RedisConnection(database);
}

EditorCommon.prototype.connect = async function () {
  return this.redis.connect();
};

EditorCommon.prototype.isConnected = function () {
  return this.redis.isConnected();
};

EditorCommon.prototype.ping = async function () {
  return this.redis.command(['PING']);
};

EditorCommon.prototype.close = async function () {
  return this.redis.close();
};

EditorCommon.prototype.healthCheck = async function () {
  try {
    return (await this.ping()) === 'PONG';
  } catch (_e) {
    return false;
  }
};

EditorCommon.prototype._eval = function (script, keys, args) {
  return this.redis.eval(script, keys, args);
};

EditorCommon.prototype._command = function (args) {
  return this.redis.command(args);
};

EditorCommon.prototype._commands = function (commands) {
  return this.redis.commands(commands);
};

EditorCommon.prototype._docBase = function (ctx, docId) {
  return `${cfgRedisPrefix}{editor:${encodePart(tenantName(ctx))}:${encodePart(docId)}}:`;
};

EditorCommon.prototype._statBase = function (ctx) {
  return `${cfgRedisPrefix}{stat:${encodePart(tenantName(ctx))}}:`;
};

EditorCommon.prototype._checkAndLock = async function (ctx, name, docId, fencingToken, ttl) {
  const key = `${this._docBase(ctx, docId)}${name}`;
  const result = await this._eval(LOCK_SCRIPT, [key], [jsonEncode(fencingToken), String(ttlMilliseconds(ttl))]);
  return Number(result) === 1;
};

EditorCommon.prototype._checkAndUnlock = async function (ctx, name, docId, fencingToken) {
  const key = `${this._docBase(ctx, docId)}${name}`;
  const unlock = commonDefines.c_oAscUnlockRes;
  const result = await this._eval(
    UNLOCK_SCRIPT,
    [key],
    [jsonEncode(fencingToken), String(unlock.Unlocked), String(unlock.Empty), String(unlock.Locked)]
  );
  return Number(result);
};

module.exports = {
  RedisConnection,
  EditorCommon,
  cfgRedisPrefix,
  cfgExpPresence,
  cfgExpLocks,
  cfgExpMessage,
  cfgExpForceSave,
  cfgExpSaved,
  cfgExpMonthUniqueUsers,
  encodePart,
  documentMember,
  decodeDocumentMember,
  ttlSeconds,
  ttlMilliseconds,
  jsonEncode,
  jsonDecode,
  decodeHash,
  argsFromObject,
  strictMax,
  toRedisString,
  LOCK_SCRIPT,
  UNLOCK_SCRIPT,
  ADD_PRESENCE_SCRIPT,
  UPDATE_PRESENCE_SCRIPT,
  GET_PRESENCE_SCRIPT,
  REMOVE_PRESENCE_SCRIPT,
  PREPARE_PRESENCE_REMOVAL_SCRIPT,
  REMOVE_DOCUMENT_INDEX_SCRIPT,
  POP_EXPIRED_SCRIPT,
  ADD_LOCKS_SCRIPT,
  ADD_LOCKS_NX_SCRIPT,
  REMOVE_LOCKS_SCRIPT,
  ADD_MESSAGE_SCRIPT,
  GETDEL_SCRIPT,
  START_FORCE_SAVE_SCRIPT,
  SET_FORCE_SAVE_SCRIPT,
  STORE_FORCE_SAVE_SCRIPT,
  ADD_MONTH_USER_SCRIPT,
  ADD_UNIQUE_USER_SCRIPT,
  GET_UNIQUE_USERS_SCRIPT,
  SET_CONNECTION_SAMPLE_SCRIPT,
  SET_SHARD_COUNT_SCRIPT,
  INCR_SHARD_COUNT_SCRIPT,
  GET_SHARD_COUNT_SCRIPT,
  CLEAN_DOCUMENT_SCRIPT
};
