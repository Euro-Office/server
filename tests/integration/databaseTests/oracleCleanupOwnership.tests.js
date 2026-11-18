/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {afterAll, afterEach, beforeAll, describe, expect, jest, test} = require('@jest/globals');
const {randomUUID} = require('node:crypto');
const config = require('../../../Common/node_modules/config');
const oracledb = require('../../../DocService/node_modules/oracledb');
const canvasservice = require('../../../DocService/sources/canvasservice');
const commonDefines = require('../../../Common/sources/commondefines');
const operationContext = require('../../../Common/sources/operationContext');
const sqlBase = require('../../../DocService/sources/databaseConnectors/baseConnector');
const taskResult = require('../../../DocService/sources/taskresult');

const sqlConfig = config.get('services.CoAuthoring.sql');
const tableResult = sqlConfig.get('tableResult');
const tableChanges = sqlConfig.get('tableChanges');
const oracleDescribe = sqlConfig.get('type') === 'oracle' ? describe : describe.skip;
const timeoutMs = 10000;

function signal() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return {promise, resolve};
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Oracle transaction coordination timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

oracleDescribe('Oracle cleanup/takeover transactions', () => {
  const ctx = new operationContext.Context();
  ctx.setTenant('oracle-cleanup-race-tests');
  let pool;
  let docId;

  beforeAll(async () => {
    await sqlBase.healthCheck(ctx);
    pool = oracledb.getPool();
  });

  afterEach(async () => {
    try {
      if (docId) {
        await sqlBase.deleteChangesPromise(ctx, docId, null);
        await taskResult.remove(ctx, docId);
        docId = undefined;
      }
    } finally {
      jest.restoreAllMocks();
    }
  });

  afterAll(async () => {
    await sqlBase.closePool();
  });

  async function fixture() {
    docId = `oracle-cleanup-${randomUUID()}`;
    const task = new taskResult.TaskResultData();
    task.tenant = ctx.tenant;
    task.key = docId;
    task.status = commonDefines.FileStatus.UpdateVersion;
    // An undated abandoned cleanup claim can be taken over immediately.
    task.statusInfo = commonDefines.FINAL_SAVE_PENDING_STATUS_INFO + 12;
    task.callback = 'https://callback.example.test/save';
    await taskResult.upsert(ctx, task);
    await sqlBase.insertChangesPromise(ctx, [{change: 'original edit', time: new Date()}], docId, 0, {
      id: 'user',
      idOriginal: 'user',
      username: 'User'
    });
    const [row] = await taskResult.select(ctx, docId);
    return {row, mask: {tenant: ctx.tenant, key: docId, status: task.status, statusInfo: task.statusInfo}};
  }

  // Instrument real, independent pooled connections. Every SQL statement still
  // runs on Oracle; only the commit boundary is held at an explicit barrier.
  // Disabling autocommit also reproduces the old DELETE awaiting its commit.
  function coordinate(intercept) {
    const getConnection = pool.getConnection.bind(pool);
    jest.spyOn(pool, 'getConnection').mockImplementation(async () => {
      const connection = await getConnection();
      connection.callTimeout = timeoutMs;
      const execute = connection.execute.bind(connection);
      try {
        const session = await execute("SELECT TO_NUMBER(SYS_CONTEXT('USERENV', 'SID')) FROM DUAL", [], {
          autoCommit: false,
          outFormat: oracledb.OUT_FORMAT_ARRAY
        });
        const sid = session.rows[0][0];
        jest.spyOn(connection, 'execute').mockImplementation((sql, binds, options = {}) => intercept(connection, execute, sql, binds, options, sid));
        return connection;
      } catch (error) {
        await connection.close();
        throw error;
      }
    });
  }

  async function pauseDml(connection, execute, sql, binds, options, reached, release, sid) {
    const result = await execute(sql, binds, {...options, autoCommit: false});
    reached.resolve(sid);
    await bounded(release.promise);
    if (options.autoCommit ?? oracledb.autoCommit) {
      await connection.commit();
    }
    return result;
  }

  // Requires GRANT SELECT ON sys.v_$session TO <test user> (set up in Oracle CI).
  // Poll database state, not elapsed time or driver submission, before releasing
  // the blocker. The observer has its own connection while the contender waits.
  async function waitForBlocked(waiterSid, blockerSid) {
    const observer = await pool.getConnection();
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await observer.execute(
          'SELECT sid FROM v$session WHERE sid=:0 AND blocking_session=:1 ' +
            "AND blocking_session_status='VALID' AND state='WAITING' AND event='enq: TX - row lock contention'",
          [waiterSid, blockerSid],
          {autoCommit: false}
        );
        if (result.rows.length === 1) {
          return;
        }
        await new Promise(setImmediate);
      }
      throw new Error(`Oracle session ${waiterSid} did not block on session ${blockerSid}`);
    } finally {
      await observer.close();
    }
  }

  async function isLocked(table) {
    const connection = await pool.getConnection();
    connection.callTimeout = timeoutMs;
    try {
      await connection.execute(`SELECT 1 FROM ${table} WHERE tenant=:0 AND id=:1 FOR UPDATE NOWAIT`, [ctx.tenant, docId], {autoCommit: false});
      return false;
    } catch (error) {
      if (error.errorNum === 54) {
        return true;
      }
      throw error;
    } finally {
      try {
        await connection.rollback();
      } finally {
        await connection.close();
      }
    }
  }

  async function expectState(status, edits) {
    const [row] = await taskResult.select(ctx, docId);
    expect(row).toMatchObject({status, status_info: 0});
    expect(row.callback).toContain('callback.example.test');
    const changes = await sqlBase.getChangesPromise(ctx, docId);
    expect(changes.map(change => change.change_data.toString())).toEqual(edits);
    expect(pool.connectionsInUse).toBe(0);
    expect(sqlBase.isLockCriticalSection(docId)).toBe(false);
  }

  test('deletion first: takeover reloads after the pending deletion commits', async () => {
    const {row, mask} = await fixture();
    const deleted = signal();
    const release = signal();
    const takeoverIssued = signal();
    coordinate((connection, execute, sql, binds, options, sid) => {
      if (sql.startsWith(`DELETE FROM ${tableChanges}`)) {
        return pauseDml(connection, execute, sql, binds, options, deleted, release, sid);
      }
      if (sql.startsWith(`UPDATE ${tableResult}`)) {
        takeoverIssued.resolve(sid);
      }
      return execute(sql, binds, options);
    });
    const cleanup = taskResult.deleteChangesIf(ctx, mask);
    cleanup.catch(() => {});
    let takeover;
    let status;
    let locked;
    try {
      const deletingSid = await bounded(deleted.promise);
      // An independent consistent read still sees the uncommitted deletion.
      expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(1);
      locked = await isLocked(tableResult);
      takeover = canvasservice.takeOverAbandonedSaveForOpen(ctx, docId, row);
      takeover.catch(() => {});
      const takeoverSid = await bounded(takeoverIssued.promise);
      if (locked) {
        await waitForBlocked(takeoverSid, deletingSid);
      } else {
        // Before the fix, complete the actual unsafe open before letting the
        // deletion commit. No timing assumption is needed to reproduce it.
        status = await bounded(takeover);
      }
    } finally {
      release.resolve();
      await bounded(Promise.allSettled([cleanup, takeover]));
    }
    await expect(cleanup).resolves.toMatchObject({affectedRows: 1});
    status = status ?? (await takeover);
    await expectState(status, []);
    expect(status).toBe(commonDefines.FileStatus.None);
    expect(locked).toBe(true);
  }, 30000);

  test('takeover first: cleanup revalidates ownership after waiting and retains the edits', async () => {
    const {row, mask} = await fixture();
    const held = signal();
    const release = signal();
    const cleanupIssued = signal();
    let cleanupLocksTask = false;
    coordinate(async (connection, execute, sql, binds, options, sid) => {
      if (sql.startsWith(`UPDATE ${tableResult}`) && binds.includes(commonDefines.FINAL_SAVE_TAKEOVER_STATUS_INFO)) {
        return pauseDml(connection, execute, sql, binds, options, held, release, sid);
      }
      if (sql.endsWith('FOR UPDATE')) {
        cleanupLocksTask = true;
        cleanupIssued.resolve(sid);
      }
      const result = await execute(sql, binds, options);
      if (!cleanupLocksTask && sql.startsWith(`DELETE FROM ${tableChanges}`)) {
        // The old unlocked DELETE must finish while the takeover is still
        // uncommitted, rather than racing the test's release of that hold.
        cleanupIssued.resolve(sid);
      }
      return result;
    });
    const takeover = canvasservice.takeOverAbandonedSaveForOpen(ctx, docId, row);
    takeover.catch(() => {});
    let cleanup;
    try {
      const takeoverSid = await bounded(held.promise);
      expect(await isLocked(tableResult)).toBe(true);
      cleanup = taskResult.deleteChangesIf(ctx, mask);
      cleanup.catch(() => {});
      const cleanupSid = await bounded(cleanupIssued.promise);
      if (cleanupLocksTask) {
        await waitForBlocked(cleanupSid, takeoverSid);
      }
    } finally {
      release.resolve();
      await bounded(Promise.allSettled([cleanup, takeover]));
    }
    await expect(takeover).resolves.toBe(commonDefines.FileStatus.Ok);
    await expect(cleanup).resolves.toMatchObject({affectedRows: 0});
    await expectState(commonDefines.FileStatus.Ok, ['original edit']);
    await expect(taskResult.deleteChangesIf(ctx, mask)).resolves.toMatchObject({affectedRows: 0});
    await expectState(commonDefines.FileStatus.Ok, ['original edit']);
  }, 30000);

  test('a failure after deletion rolls back, releases locks and permits repeated cleanup', async () => {
    const {mask} = await fixture();
    const failure = new Error('failure after real Oracle deletion');
    let failOnce = true;
    coordinate(async (_connection, execute, sql, binds, options) => {
      const result = await execute(sql, binds, options);
      if (failOnce && sql.startsWith(`DELETE FROM ${tableChanges}`)) {
        failOnce = false;
        throw failure;
      }
      return result;
    });
    await expect(taskResult.deleteChangesIf(ctx, mask)).rejects.toBe(failure);
    expect(pool.connectionsInUse).toBe(0);
    expect(sqlBase.isLockCriticalSection(docId)).toBe(false);
    expect(await isLocked(tableResult)).toBe(false);
    expect(await isLocked(tableChanges)).toBe(false);
    expect((await taskResult.select(ctx, docId))[0]).toMatchObject({status: mask.status, status_info: mask.statusInfo});
    const changes = await sqlBase.getChangesPromise(ctx, docId);
    expect(changes.map(change => change.change_data.toString())).toEqual(['original edit']);

    await expect(taskResult.deleteChangesIf(ctx, mask)).resolves.toMatchObject({affectedRows: 1});
    await expect(taskResult.deleteChangesIf(ctx, mask)).resolves.toMatchObject({affectedRows: 0});
    expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(0);
    expect((await taskResult.select(ctx, docId))[0]).toMatchObject({status: mask.status, status_info: mask.statusInfo});
    expect(await isLocked(tableResult)).toBe(false);
    expect(pool.connectionsInUse).toBe(0);
  }, 30000);

  test.each([false, true])(
    'a failed release returns the connection through the drop fallback (%s)',
    async failed => {
      const {mask} = await fixture();
      const operationError = new Error('failure after real Oracle deletion');
      const getConnection = pool.getConnection.bind(pool);
      let connection;
      jest.spyOn(pool, 'getConnection').mockImplementationOnce(async () => {
        connection = await getConnection();
        connection.callTimeout = timeoutMs;
        const close = connection.close.bind(connection);
        jest.spyOn(connection, 'close').mockRejectedValueOnce(new Error('release failed before reaching driver')).mockImplementation(close);
        if (failed) {
          const execute = connection.execute.bind(connection);
          jest.spyOn(connection, 'execute').mockImplementation(async (...args) => {
            const result = await execute(...args);
            if (args[0].startsWith(`DELETE FROM ${tableChanges}`)) {
              throw operationError;
            }
            return result;
          });
        }
        return connection;
      });
      const deletion = taskResult.deleteChangesIf(ctx, mask);
      if (failed) {
        await expect(deletion).rejects.toBe(operationError);
      } else {
        await expect(deletion).resolves.toMatchObject({affectedRows: 1});
      }
      expect(connection.close).toHaveBeenCalledTimes(2);
      expect(connection.close).toHaveBeenNthCalledWith(1, {drop: false});
      expect(connection.close).toHaveBeenNthCalledWith(2, {drop: true});
      expect(pool.connectionsInUse).toBe(0);
      expect(sqlBase.isLockCriticalSection(docId)).toBe(false);
      expect(await isLocked(tableResult)).toBe(false);
      expect(await isLocked(tableChanges)).toBe(false);
      const changes = await sqlBase.getChangesPromise(ctx, docId);
      expect(changes.map(change => change.change_data.toString())).toEqual(failed ? ['original edit'] : []);
      expect((await taskResult.select(ctx, docId))[0]).toMatchObject({status: mask.status, status_info: mask.statusInfo});
      await expect(taskResult.deleteChangesIf(ctx, mask)).resolves.toMatchObject({affectedRows: failed ? 1 : 0});
      expect(await sqlBase.getChangesPromise(ctx, docId)).toHaveLength(0);
      expect(pool.connectionsInUse).toBe(0);
    },
    30000
  );
});
