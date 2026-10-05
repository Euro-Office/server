/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {REDIS_COMMAND_TIMEOUT_MS} = require('../redisConfig');

class RedisConnection {
  constructor(database, {serializeOperations = false} = {}) {
    this.database = database;
    // A node-redis client multiplexes commands, but its queue cannot safely
    // remove a command that has already been written. If that command times
    // out, its physical connection must be aborted to avoid matching a late
    // reply with a different operation. Editor-data enables this lane from
    // the connection manager so queued operations can continue on a fresh
    // client generation without sharing a half-open socket.
    this.serializeOperations = serializeOperations;
    this.client = null;
    this.connectPromise = null;
    this.connector = null;
    this.cluster = false;
    this.sentinel = false;
    this.connectionAttempted = false;
    this.lastError = null;
    this.commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.activeOperations = 0;
    this.idleWaiters = [];
    this.operationTail = Promise.resolve();
    this.clientGeneration = 0;
  }
}

module.exports = RedisConnection;
