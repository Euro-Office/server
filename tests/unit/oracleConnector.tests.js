/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {beforeEach, describe, expect, jest, test} = require('@jest/globals');

jest.mock('../../Common/sources/utils', () => ({}));
jest.mock('../../Common/sources/operationContext', () => ({}));

const ctx = {tenant: 'cleanup-tenant', logger: {error: jest.fn()}};
const docId = 'cleanup-document';
const sql =
  'DELETE FROM doc_changes WHERE tenant=:0 AND id=:1 AND ' +
  'EXISTS (SELECT 1 FROM task_result WHERE tenant=:2 AND id=:3 AND status=:4 AND status_info=:5);';
const values = [ctx.tenant, docId, ctx.tenant, docId, 7, 123];

function makeConnection() {
  return {
    execute: jest
      .fn()
      .mockResolvedValueOnce({rows: [[1]]})
      .mockResolvedValue({rowsAffected: 1}),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined)
  };
}

describe('Oracle conditional change deletion transaction', () => {
  let connector;
  let driver;
  let pool;
  let connection;

  beforeEach(() => {
    jest.resetModules();
    connection = makeConnection();
    pool = {getConnection: jest.fn().mockResolvedValue(connection)};
    driver = {createPool: jest.fn().mockResolvedValue(pool), DB_TYPE_NCLOB: 'NCLOB', OUT_FORMAT_OBJECT: 'OBJECT'};
    jest.doMock('../../DocService/node_modules/oracledb', () => driver);
    connector = require('../../DocService/sources/databaseConnectors/oracleConnector');
  });

  test('binds large operation snapshots as NCLOB without changing ordinary parameter binding', () => {
    const values = [];
    const snapshot = 'é'.repeat(40000);
    expect(connector.addSqlParameter(snapshot, values, true)).toBe(':0');
    expect(connector.addSqlParameter('document', values)).toBe(':1');
    expect(values).toEqual([{val: snapshot, type: driver.DB_TYPE_NCLOB}, 'document']);
  });

  test.each([false, true])('keeps storage under the row lock and releases after its result (failure: %s)', async failed => {
    connection.execute.mockReset().mockResolvedValue({
      rows: [{ID: docId, CALLBACK: 'callback', ADDITIONAL: null}],
      metaData: [{name: 'ADDITIONAL', dbType: driver.DB_TYPE_NCLOB}]
    });
    let entered, finish;
    const started = new Promise(resolve => (entered = resolve));
    const pending = new Promise(resolve => (finish = resolve));
    const failure = new Error('storage failed');
    const cleanup = connector.withTaskResultLock(ctx, docId, {sql: 'status=:0', values: [7]}, async row => {
      expect(row).toEqual({id: docId, callback: 'callback', additional: ''});
      expect(pool.getConnection).toHaveBeenCalledTimes(1);
      entered();
      await pending;
      if (failed) throw failure;
    });
    await started;
    expect(connection.execute).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE status=:0'), [7], {
      autoCommit: false,
      outFormat: driver.OUT_FORMAT_OBJECT
    });
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    finish();
    if (failed) {
      await expect(cleanup).rejects.toBe(failure);
      expect(connection.rollback).toHaveBeenCalledTimes(1);
      expect(connection.commit).not.toHaveBeenCalled();
    } else {
      await expect(cleanup).resolves.toBe(true);
      expect(connection.commit).toHaveBeenCalledTimes(1);
    }
    expect(connection.close).toHaveBeenCalledWith({drop: false});
  });

  test('does not run storage after ownership changed while waiting for the lock', async () => {
    connection.execute
      .mockReset()
      .mockResolvedValueOnce({rows: [[1]]})
      .mockResolvedValueOnce({rows: []});
    const action = jest.fn();
    await expect(connector.withTaskResultLock(ctx, docId, {sql: 'status=:0', values: [7]}, action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledWith({drop: false});
  });

  test('holds the task row while revalidating ownership and deleting on the same connection', async () => {
    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).resolves.toEqual({affectedRows: 1});

    expect(driver.autoCommit).toBe(true);
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    const [lockSql, lockValues, lockOptions] = connection.execute.mock.calls[0];
    expect(lockSql).toMatch(/^SELECT 1 FROM \S+ WHERE tenant=:0 AND id=:1 FOR UPDATE$/);
    expect(lockValues).toEqual([ctx.tenant, docId]);
    expect(lockOptions.autoCommit).toBe(false);
    expect(connection.execute).toHaveBeenNthCalledWith(2, sql.slice(0, -1), values, {autoCommit: false});
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledWith({drop: false});
    expect(connection.execute.mock.invocationCallOrder[1]).toBeLessThan(connection.commit.mock.invocationCallOrder[0]);
    expect(connection.commit.mock.invocationCallOrder[0]).toBeLessThan(connection.close.mock.invocationCallOrder[0]);
  });

  test('does not delete changes when the task row is absent', async () => {
    connection.execute.mockReset().mockResolvedValue({rows: []});

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).resolves.toEqual({affectedRows: 0});

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  test('commits and releases each connection when ownership no longer matches or cleanup repeats', async () => {
    const retryConnection = makeConnection();
    for (const current of [connection, retryConnection]) {
      current.execute
        .mockReset()
        .mockResolvedValueOnce({rows: [[1]]})
        .mockResolvedValue({rowsAffected: 0});
    }
    pool.getConnection.mockResolvedValueOnce(connection).mockResolvedValueOnce(retryConnection);

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).resolves.toEqual({affectedRows: 0});
    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).resolves.toEqual({affectedRows: 0});

    expect(driver.createPool).toHaveBeenCalledTimes(1);
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
    for (const current of [connection, retryConnection]) {
      expect(current.execute).toHaveBeenNthCalledWith(2, sql.slice(0, -1), values, {autoCommit: false});
      expect(current.commit).toHaveBeenCalledTimes(1);
      expect(current.rollback).not.toHaveBeenCalled();
      expect(current.close).toHaveBeenCalledTimes(1);
    }
  });

  test.each(['lock', 'delete', 'commit'])('rolls back and releases the connection after a %s failure', async stage => {
    const error = new Error(`${stage} failed`);
    if (stage === 'lock') {
      connection.execute.mockReset().mockRejectedValue(error);
    } else if (stage === 'delete') {
      connection.execute
        .mockReset()
        .mockResolvedValueOnce({rows: [[1]]})
        .mockRejectedValue(error);
    } else {
      connection.commit.mockRejectedValue(error);
    }
    const retryConnection = makeConnection();
    pool.getConnection.mockResolvedValueOnce(connection).mockResolvedValueOnce(retryConnection);

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).rejects.toBe(error);

    expect(connection.execute).toHaveBeenCalledTimes(stage === 'lock' ? 1 : 2);
    expect(connection.commit).toHaveBeenCalledTimes(stage === 'commit' ? 1 : 0);
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(connection.rollback.mock.invocationCallOrder[0]).toBeLessThan(connection.close.mock.invocationCallOrder[0]);

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).resolves.toEqual({affectedRows: 1});
    expect(retryConnection.commit).toHaveBeenCalledTimes(1);
    expect(retryConnection.rollback).not.toHaveBeenCalled();
    expect(retryConnection.close).toHaveBeenCalledTimes(1);
  });

  test('preserves the operation error and still closes when rollback fails', async () => {
    const error = new Error('delete failed');
    connection.execute
      .mockReset()
      .mockResolvedValueOnce({rows: [[1]]})
      .mockRejectedValue(error);
    connection.rollback.mockRejectedValue(new Error('rollback failed'));

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).rejects.toBe(error);

    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledWith({drop: true});
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  test.each([false, true])('drops the connection after release fails (operation failed: %s)', async failed => {
    const operationError = new Error('delete failed');
    if (failed) {
      connection.execute
        .mockReset()
        .mockResolvedValueOnce({rows: [[1]]})
        .mockRejectedValue(operationError);
    }
    connection.close.mockRejectedValueOnce(new Error('close failed'));

    const deletion = connector.deleteChangesIf(ctx, docId, sql, values);
    if (failed) {
      await expect(deletion).rejects.toBe(operationError);
    } else {
      await expect(deletion).resolves.toEqual({affectedRows: 1});
    }

    expect(connection.commit).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(connection.rollback).toHaveBeenCalledTimes(failed ? 1 : 0);
    expect(connection.close).toHaveBeenCalledTimes(2);
    expect(connection.close).toHaveBeenNthCalledWith(1, {drop: false});
    expect(connection.close).toHaveBeenNthCalledWith(2, {drop: true});
  });

  test.each([false, true])('surfaces an unrecoverable release failure without hiding an operation error (%s)', async failed => {
    const operationError = new Error('delete failed');
    const closeError = new Error('close failed');
    if (failed) {
      connection.execute
        .mockReset()
        .mockResolvedValueOnce({rows: [[1]]})
        .mockRejectedValue(operationError);
    }
    connection.close.mockRejectedValueOnce(closeError).mockRejectedValueOnce(new Error('drop failed'));

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).rejects.toBe(failed ? operationError : closeError);

    expect(connection.close).toHaveBeenCalledTimes(2);
    expect(connection.close).toHaveBeenLastCalledWith({drop: true});
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('connection drop error'));
  });

  test.each(['pool creation', 'connection acquisition'])('can retry a failed %s', async stage => {
    const error = new Error(`${stage} failed`);
    if (stage === 'pool creation') {
      driver.createPool.mockRejectedValueOnce(error);
    } else {
      pool.getConnection.mockRejectedValueOnce(error);
    }

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).rejects.toBe(error);

    expect(connection.execute).not.toHaveBeenCalled();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();

    await expect(connector.deleteChangesIf(ctx, docId, sql, values)).resolves.toEqual({affectedRows: 1});
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
