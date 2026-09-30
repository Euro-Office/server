/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';
const crypto = require('crypto');
const {RedisConnection, RedisUnavailableError} = require('./redisConnection');
const {cfgRedisName, cfgRedisHost, cfgRedisPort, cfgRedisOptions, cfgRedisOptionsCluster, cfgRedisOptionsSentinel} = require('./redisConfig');

function connectionDatabaseKey(database) {
  if (database === undefined || database === null || database === '') {
    return 0;
  }
  return Number(database);
}

function stableConnectionValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableConnectionValue);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableConnectionValue(value[key]);
        return result;
      }, {});
  }
  if (typeof value === 'function') {
    return String(value);
  }
  return value;
}

const connectionGroups = Object.freeze({
  default: 'default',
  editorData: 'editor-data',
  editorStat: 'editor-stat'
});

function connectionScope(database, group = connectionGroups.default) {
  // Groups are caller-defined scope labels. The exported groups cover the
  // built-in stores, while tests and extensions may intentionally share a
  // custom scope.
  const serialized = JSON.stringify(
    stableConnectionValue({
      database: connectionDatabaseKey(database),
      group,
      connector: cfgRedisName,
      host: cfgRedisHost,
      port: cfgRedisPort,
      options: cfgRedisOptions,
      cluster: cfgRedisOptionsCluster,
      sentinel: cfgRedisOptionsSentinel
    })
  );
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

class RedisConnectionManager {
  constructor(createConnection = database => new RedisConnection(database)) {
    this.connections = new Map();
    this.createConnection = createConnection;
    this.terminal = false;
  }

  acquire(database, group = connectionGroups.default) {
    if (this.terminal) {
      throw new RedisUnavailableError(new Error('Redis connection manager is shut down'));
    }
    const scope = connectionScope(database, group);
    let entry = this.connections.get(scope);
    if (!entry) {
      entry = {connection: this.createConnection(connectionDatabaseKey(database)), references: 0};
      this.connections.set(scope, entry);
    }
    entry.references++;
    return entry.connection;
  }

  async release(connection) {
    for (const [key, entry] of this.connections) {
      if (entry.connection !== connection) {
        continue;
      }
      entry.references = Math.max(0, entry.references - 1);
      if (entry.references === 0) {
        this.connections.delete(key);
        await entry.connection.close();
      }
      return;
    }
  }

  owns(connection) {
    return [...this.connections.values()].some(entry => entry.connection === connection);
  }

  async closeAll({terminal = true} = {}) {
    if (terminal) {
      this.terminal = true;
    }
    const entries = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(entries.map(entry => entry.connection.close()));
  }

  size() {
    return this.connections.size;
  }
}

const redisConnectionManager = new RedisConnectionManager();

module.exports = {
  RedisConnectionManager,
  redisConnectionManager,
  connectionScope,
  connectionGroups
};
