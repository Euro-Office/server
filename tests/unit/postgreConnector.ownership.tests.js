/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {EventEmitter} = require('node:events');
const {afterEach, beforeEach, describe, expect, jest, test} = require('@jest/globals');

jest.mock('../../Common/sources/operationContext', () => ({}));

const row = {id: 'document', callback: 'original-callback', additional: 'original-marker'};
const ctx = {tenant: 'tenant', logger: {error: jest.fn()}};

// Keep the real pg pool's connection limit and checkout/release behavior;
// only the client that executes SQL is replaced.
class QueryClient extends EventEmitter {
  constructor() {
    super();
    this._queryable = true;
  }

  connect(callback) {
    queueMicrotask(() => callback(null));
  }

  query(sql, values, callback) {
    if (typeof values === 'function') callback = values;
    const result = {command: 'SELECT', rowCount: 1, rows: sql.startsWith('SELECT *') ? [{...row}] : [{owned: 1}]};
    if (callback) {
      queueMicrotask(() => callback(null, result));
      return;
    }
    return Promise.resolve(result);
  }

  end(callback) {
    callback?.();
  }
}

describe('PostgreSQL cleanup ownership with one pooled connection', () => {
  let connector;
  let pool;

  beforeEach(() => {
    jest.resetModules();
    const pg = jest.requireActual('../../DocService/node_modules/pg');
    jest.doMock('../../DocService/node_modules/pg', () => ({
      ...pg,
      Pool: class extends pg.Pool {
        constructor(options) {
          super({...options, max: 1, connectionTimeoutMillis: 100, Client: QueryClient});
          pool = this;
        }
      }
    }));
    connector = require('../../DocService/sources/databaseConnectors/postgreConnector');
  });

  afterEach(async () => {
    await pool.end();
    jest.restoreAllMocks();
  });

  test.each([false, true])('supplies the locked row without another checkout and releases on failure (%s)', async fail => {
    const connect = jest.spyOn(pool, 'connect');
    const failure = new Error('external operation failed');
    const condition = {sql: 'tenant=$1 AND id=$2', values: [ctx.tenant, row.id]};
    const action = jest.fn(async lockedRow => {
      expect(lockedRow).toEqual(row);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
      expect(connect).toHaveBeenCalledTimes(1);
      if (fail) throw failure;
    });

    const cleanup = connector.withTaskResultLock(ctx, row.id, condition, action);
    if (fail) {
      await expect(cleanup).rejects.toBe(failure);
    } else {
      await expect(cleanup).resolves.toBe(true);
    }
    expect(action).toHaveBeenCalledTimes(1);
    expect(pool.idleCount).toBe(1);
    await expect(connector.withTaskResultLock(ctx, row.id, condition, async lockedRow => expect(lockedRow).toEqual(row))).resolves.toBe(true);
  });
});
