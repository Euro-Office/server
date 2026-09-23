'use strict';

require('./testSetup');

const assert = require('node:assert/strict');

const commonDefines = require('../../Common/sources/commondefines');
const {EditorData, EditorStat} = require('../../DocService/sources/editorDataRedis');

function context(tenant, overrides = {}) {
  return {
    tenant,
    getCfg(path, fallback) {
      return Object.hasOwn(overrides, path) ? overrides[path] : fallback;
    }
  };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function race(count, action) {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const tasks = Array.from({length: count}, (_, index) => gate.then(() => action(index)));
  release();
  return Promise.all(tasks);
}

function collectMethods(instance) {
  const result = new Set();
  let prototype = Object.getPrototypeOf(instance);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor' && typeof prototype[name] === 'function' && !name.startsWith('_')) {
        result.add(name);
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return [...result].sort();
}

async function verify() {
  const dataStores = Array.from({length: 4}, () => new EditorData());
  const statStores = Array.from({length: 4}, () => new EditorStat());
  const resources = [...dataStores, ...statStores];
  const data = dataStores[0];
  const stat = statStores[0];
  const ctx = context('tenant:{}:/世界');
  const otherCtx = context('tenant:{}:/世界:other');

  try {
    const expectedDataMethods = [
      'addForceSaveTimerNX',
      'addLocks',
      'addLocksNX',
      'addMessage',
      'addPresence',
      'checkAndSetForceSave',
      'checkAndStartForceSave',
      'cleanDocumentOnExit',
      'close',
      'connect',
      'getDocumentPresenceExpired',
      'getForceSave',
      'getForceSaveTimer',
      'getLocks',
      'getMessages',
      'getPresence',
      'getdelSaved',
      'healthCheck',
      'isConnected',
      'lockAuth',
      'lockSave',
      'ping',
      'removeAllLocks',
      'removeForceSave',
      'removeLocks',
      'removeMessages',
      'removePresence',
      'removePresenceDocument',
      'setForceSave',
      'setSaved',
      'unlockAuth',
      'unlockSave',
      'updatePresence'
    ].sort();
    const expectedStatMethods = [
      'addPresenceUniqueUser',
      'addPresenceUniqueUsersOfMonth',
      'addPresenceUniqueViewUser',
      'addPresenceUniqueViewUsersOfMonth',
      'addShutdown',
      'cleanupShutdown',
      'close',
      'connect',
      'deleteKey',
      'getEditorConnections',
      'getEditorConnectionsCount',
      'getLicense',
      'getLiveViewerConnectionsCount',
      'getPresenceUniqueUser',
      'getPresenceUniqueUsersOfMonth',
      'getPresenceUniqueViewUser',
      'getPresenceUniqueViewUsersOfMonth',
      'getShutdownCount',
      'getViewerConnectionsCount',
      'healthCheck',
      'incrEditorConnectionsCountByShard',
      'incrLiveViewerConnectionsCountByShard',
      'incrViewerConnectionsCountByShard',
      'isConnected',
      'lockNotification',
      'ping',
      'removeLicense',
      'removeShutdown',
      'setEditorConnections',
      'setEditorConnectionsCountByShard',
      'setLicense',
      'setLiveViewerConnectionsCountByShard',
      'setViewerConnectionsCountByShard'
    ].sort();
    assert.deepEqual(collectMethods(data), expectedDataMethods);
    assert.deepEqual(collectMethods(stat), expectedStatMethods);

    await Promise.all(Array.from({length: 20}, () => data.connect()));
    assert.equal(data.isConnected(), true);
    assert.equal(await data.ping(), 'PONG');
    assert.equal(await data.healthCheck(), true);

    const coldStat = new EditorStat();
    resources.push(coldStat);
    assert.equal(await coldStat.lockNotification(ctx, 'cold-start', 5), true);

    const presenceCtx = context(ctx.tenant, {'services.CoAuthoring.expire.presence': 1});
    const presenceDoc = 'presence:{}:/文';
    const userOneInfo = JSON.stringify({id: 'user:1', username: '世界'});
    const userTwoInfo = JSON.stringify({id: 'user:{2}', username: 'two'});
    await data.addPresence(presenceCtx, presenceDoc, 'user:1', userOneInfo);
    await data.addPresence(presenceCtx, presenceDoc, 'user:{2}', userTwoInfo);
    assert.deepEqual(new Set(await data.getPresence(presenceCtx, presenceDoc)), new Set([userOneInfo, userTwoInfo]));
    await data.removePresenceDocument(presenceCtx, presenceDoc);
    assert.equal((await data.getPresence(presenceCtx, presenceDoc)).length, 2);
    await wait(650);
    await dataStores[1].updatePresence(presenceCtx, presenceDoc, 'user:1');
    await wait(500);
    assert.deepEqual(await dataStores[2].getPresence(presenceCtx, presenceDoc), [userOneInfo]);
    await data.removePresence(presenceCtx, presenceDoc, 'user:1');
    await data.removePresenceDocument(presenceCtx, presenceDoc);
    assert.deepEqual(await data.getPresence(presenceCtx, presenceDoc), []);

    const isolatedDoc = 'tenant-isolation';
    await data.addPresence(ctx, isolatedDoc, 'user', JSON.stringify({id: 'user'}));
    await data.addMessage(ctx, isolatedDoc, {tenant: ctx.tenant});
    assert.deepEqual(await data.getPresence(otherCtx, isolatedDoc), []);
    assert.deepEqual(await data.getMessages(otherCtx, isolatedDoc), []);
    await data.removePresence(ctx, isolatedDoc, 'user');
    await data.cleanDocumentOnExit(ctx, isolatedDoc);

    const expiringDocs = ['expired:a', 'expired:{b}', 'expired:/世界'];
    for (const docId of expiringDocs) {
      await data.addPresence(presenceCtx, docId, 'user', JSON.stringify({id: 'user'}));
    }
    await wait(1050);
    const expiredClaims = await Promise.all([
      dataStores[0].getDocumentPresenceExpired(Date.now()),
      dataStores[1].getDocumentPresenceExpired(Date.now())
    ]);
    const claimedDocs = expiredClaims
      .flat()
      .filter(item => item[0] === ctx.tenant)
      .map(item => item[1]);
    assert.deepEqual(new Set(claimedDocs), new Set(expiringDocs));
    assert.equal(claimedDocs.length, expiringDocs.length);

    const lockDoc = 'save-lock';
    const lockResults = await race(100, index => dataStores[index % dataStores.length].lockSave(ctx, lockDoc, `user-${index}`, 1));
    assert.equal(lockResults.filter(Boolean).length, 1);
    const owner = `user-${lockResults.findIndex(Boolean)}`;
    assert.equal(await data.lockSave(ctx, lockDoc, owner, 2), true);
    assert.equal(await data.unlockSave(ctx, lockDoc, 'other'), commonDefines.c_oAscUnlockRes.Locked);
    assert.equal(await data.unlockSave(ctx, lockDoc, owner), commonDefines.c_oAscUnlockRes.Unlocked);
    assert.equal(await data.unlockSave(ctx, lockDoc, owner), commonDefines.c_oAscUnlockRes.Empty);

    assert.equal(await data.lockAuth(ctx, lockDoc, 'old-owner', 1), true);
    await wait(1050);
    assert.equal(await dataStores[1].lockAuth(ctx, lockDoc, 'new-owner', 5), true);
    assert.equal(await data.unlockAuth(ctx, lockDoc, 'old-owner'), commonDefines.c_oAscUnlockRes.Locked);
    assert.equal(await data.unlockAuth(ctx, lockDoc, 'new-owner'), commonDefines.c_oAscUnlockRes.Unlocked);

    const objectLockDoc = 'object-locks';
    const [left, right] = await Promise.all([
      dataStores[0].addLocksNX(ctx, objectLockDoc, {a: {owner: 1}, b: {owner: 1}}),
      dataStores[1].addLocksNX(ctx, objectLockDoc, {b: {owner: 2}, c: {owner: 2}})
    ]);
    assert.deepEqual(Object.keys(await data.getLocks(ctx, objectLockDoc)).sort(), ['a', 'b', 'c']);
    const conflictCount = (Object.hasOwn(left.lockConflict, 'b') ? 1 : 0) + (Object.hasOwn(right.lockConflict, 'b') ? 1 : 0);
    assert.equal(conflictCount, 1);
    const oldA = (await data.getLocks(ctx, objectLockDoc)).a;
    await data.addLocks(ctx, objectLockDoc, {a: {owner: 3}});
    await data.removeLocks(ctx, objectLockDoc, {a: oldA});
    assert.equal(Object.hasOwn(await data.getLocks(ctx, objectLockDoc), 'a'), false);
    await data.removeAllLocks(ctx, objectLockDoc);
    assert.deepEqual(await data.getLocks(ctx, objectLockDoc), {});

    const messageDoc = 'messages';
    await race(50, index => dataStores[index % dataStores.length].addMessage(ctx, messageDoc, {index, text: '世界'}));
    const messages = await data.getMessages(ctx, messageDoc);
    assert.equal(messages.length, 50);
    assert.deepEqual(new Set(messages.map(message => message.index)), new Set(Array.from({length: 50}, (_, index) => index)));
    await data.removeMessages(ctx, messageDoc);
    assert.deepEqual(await data.getMessages(ctx, messageDoc), []);

    const savedDoc = 'saved';
    await data.setSaved(ctx, savedDoc, '1');
    const savedReads = await race(100, index => dataStores[index % dataStores.length].getdelSaved(ctx, savedDoc));
    assert.equal(savedReads.filter(value => value === '1').length, 1);
    assert.equal(savedReads.filter(value => value === null).length, 99);

    const forceDoc = 'force-save';
    await data.setForceSave(ctx, forceDoc, 100, 5, 'https://example.test', {user: 'one'}, {stale: true});
    const started = await race(100, index => dataStores[index % dataStores.length].checkAndStartForceSave(ctx, forceDoc));
    assert.equal(started.filter(Boolean).length, 1);
    assert.equal(started.find(Boolean).convertInfo, undefined);
    await data.setForceSave(ctx, forceDoc, 101, 6, 'https://example.test/new', {user: 'two'}, null);
    assert.equal(await data.checkAndSetForceSave(ctx, forceDoc, 100, 5, true, true, {stale: true}), undefined);
    const updatedForceSave = await data.checkAndSetForceSave(ctx, forceDoc, 101, 6, false, true, {url: 'result'});
    assert.equal(updatedForceSave.ended, true);
    assert.deepEqual(updatedForceSave.convertInfo, {url: 'result'});
    await data.removeForceSave(ctx, forceDoc);
    assert.equal(await data.getForceSave(ctx, forceDoc), null);

    const shortForceCtx = context(ctx.tenant, {'services.CoAuthoring.expire.forcesave': 1});
    await data.setForceSave(shortForceCtx, forceDoc, 102, 7, 'https://example.test/ttl', {}, null);
    await wait(650);
    await data.checkAndStartForceSave(shortForceCtx, forceDoc);
    await wait(500);
    assert.equal((await data.getForceSave(shortForceCtx, forceDoc)).started, true);
    await data.checkAndSetForceSave(shortForceCtx, forceDoc, 102, 7, false, true, null);
    await wait(600);
    assert.equal((await data.getForceSave(shortForceCtx, forceDoc)).ended, true);

    const timerDocs = ['timer:a', 'timer:b', 'timer:c'];
    for (const [index, docId] of timerDocs.entries()) {
      await data.addForceSaveTimerNX(ctx, docId, 100 + index);
      await data.addForceSaveTimerNX(ctx, docId, 1);
    }
    assert.deepEqual(await data.getForceSaveTimer(100), []);
    const timerClaims = await Promise.all([dataStores[0].getForceSaveTimer(104), dataStores[1].getForceSaveTimer(104)]);
    const claimedTimers = timerClaims
      .flat()
      .filter(item => item[0] === ctx.tenant)
      .map(item => item[1]);
    assert.deepEqual(new Set(claimedTimers), new Set(timerDocs));
    assert.equal(claimedTimers.length, timerDocs.length);

    await stat.addPresenceUniqueUser(ctx, 'editor', 200, {anonym: true});
    await stat.addPresenceUniqueViewUser(ctx, 'viewer', 200, {anonym: false});
    const editorUsers = await stat.getPresenceUniqueUser(ctx, 100);
    const viewerUsers = await stat.getPresenceUniqueViewUser(ctx, 100);
    assert.equal(editorUsers[0].userid, 'editor');
    assert.equal(editorUsers[0].expire.getTime(), 200000);
    assert.equal(viewerUsers[0].userid, 'viewer');
    assert.deepEqual(await stat.getPresenceUniqueUser(ctx, 200), []);

    const period = Date.UTC(2026, 0, 1);
    await stat.addPresenceUniqueUsersOfMonth(ctx, 'editor', period, {firstOpenDate: 'edit'});
    await stat.addPresenceUniqueViewUsersOfMonth(ctx, 'viewer', period, {firstOpenDate: 'view'});
    assert.deepEqual(await stat.getPresenceUniqueUsersOfMonth(ctx), {
      '2026-01-01T00:00:00.000Z': {editor: {firstOpenDate: 'edit'}}
    });
    assert.deepEqual(await stat.getPresenceUniqueViewUsersOfMonth(ctx), {
      '2026-01-01T00:00:00.000Z': {viewer: {firstOpenDate: 'view'}}
    });

    const precision = [{val: 1000}];
    const now = Date.now();
    await stat.setEditorConnections(ctx, 1, 2, 3, now - 2000, precision);
    await stat.setEditorConnections(ctx, 4, 5, 6, now, precision);
    assert.deepEqual(await stat.getEditorConnections(ctx), [{time: now, edit: 4, liveview: 5, view: 6}]);

    await stat.setEditorConnectionsCountByShard(ctx, 'shard-a', 2);
    await stat.setEditorConnectionsCountByShard(ctx, 'shard-b', 3);
    await race(100, index => statStores[index % statStores.length].incrEditorConnectionsCountByShard(ctx, 'shard-a', 1));
    assert.equal(await stat.getEditorConnectionsCount(ctx), 105);
    await stat.setViewerConnectionsCountByShard(ctx, 'shard-a', 7);
    await stat.setLiveViewerConnectionsCountByShard(ctx, 'shard-a', 11);
    assert.equal(await stat.getViewerConnectionsCount(ctx), 7);
    assert.equal(await stat.getLiveViewerConnectionsCount(ctx), 11);
    assert.equal(await stat.getEditorConnectionsCount(otherCtx), 0);
    const shortShardCtx = context('short-shard', {'services.CoAuthoring.expire.presence': 1});
    await stat.setEditorConnectionsCountByShard(shortShardCtx, 'stale', 10);
    await stat.setEditorConnectionsCountByShard(shortShardCtx, 'fresh', 20);
    await wait(650);
    await stat.setEditorConnectionsCountByShard(shortShardCtx, 'fresh', 21);
    await wait(450);
    assert.equal(await stat.getEditorConnectionsCount(shortShardCtx), 21);

    const notificationResults = await race(100, index => statStores[index % statStores.length].lockNotification(ctx, 'race-notification', 1));
    assert.equal(notificationResults.filter(Boolean).length, 1);
    assert.equal(await stat.lockNotification(otherCtx, 'race-notification', 1), true);
    await wait(1050);
    assert.equal(await stat.lockNotification(ctx, 'race-notification', 1), true);

    const shutdownKey = `${process.env.TEST_REDIS_PREFIX}shutdown`;
    await Promise.all(['a', 'b', 'b', 'c'].map(docId => stat.addShutdown(shutdownKey, docId)));
    assert.equal(await stat.getShutdownCount(shutdownKey), 3);
    await stat.removeShutdown(shutdownKey, 'b');
    assert.equal(await stat.getShutdownCount(shutdownKey), 2);
    await stat.cleanupShutdown(shutdownKey);
    assert.equal(await stat.getShutdownCount(shutdownKey), 0);

    const licenseKey = `${process.env.TEST_REDIS_PREFIX}license`;
    await stat.setLicense(licenseKey, 'license-value');
    assert.equal(await stat.getLicense(licenseKey), 'license-value');
    await stat.removeLicense(licenseKey);
    assert.equal(await stat.getLicense(licenseKey), null);

    const rawProxyKey = `${process.env.TEST_REDIS_PREFIX}proxy-key`;
    if (process.env.TEST_REDIS_CLUSTER === 'true') {
      const proxy = new EditorStat(process.env.TEST_REDIS_PROXY_DB);
      resources.push(proxy);
      await assert.rejects(proxy.ping(), /does not support a non-zero logical database/);
    } else {
      const proxy = new EditorStat(process.env.TEST_REDIS_PROXY_DB);
      resources.push(proxy);
      await stat._command(['SET', rawProxyKey, 'default-db']);
      await proxy._command(['SET', rawProxyKey, 'proxy-db']);
      await proxy.deleteKey(rawProxyKey);
      assert.equal(await proxy._command(['GET', rawProxyKey]), null);
      assert.equal(await stat._command(['GET', rawProxyKey]), 'default-db');
    }

    const cleanDoc = 'clean-target';
    const untouchedDoc = 'clean-target:other';
    const activeDoc = 'clean-target:active';
    await data.addMessage(ctx, cleanDoc, {value: 1});
    await data.addLocks(ctx, cleanDoc, {a: {value: 1}});
    await data.setSaved(ctx, cleanDoc, '1');
    await data.setForceSave(ctx, cleanDoc, 1, 1, 'url', {}, null);
    await data.addMessage(ctx, untouchedDoc, {value: 2});
    await data.addPresence(ctx, activeDoc, 'active-user', JSON.stringify({id: 'active-user'}));
    await data.addMessage(ctx, activeDoc, {value: 3});
    await data.cleanDocumentOnExit(ctx, activeDoc);
    assert.deepEqual(await data.getMessages(ctx, activeDoc), [{value: 3}]);
    await data.cleanDocumentOnExit(ctx, cleanDoc);
    await data.cleanDocumentOnExit(ctx, cleanDoc);
    assert.deepEqual(await data.getMessages(ctx, cleanDoc), []);
    assert.deepEqual(await data.getLocks(ctx, cleanDoc), {});
    assert.equal(await data.getForceSave(ctx, cleanDoc), null);
    assert.deepEqual(await data.getMessages(ctx, untouchedDoc), [{value: 2}]);

    await data.close();
    await data.close();
    assert.equal(data.isConnected(), false);
    assert.equal(await data.ping(), 'PONG');
    assert.equal(data.isConnected(), true);
  } finally {
    await Promise.all(resources.map(resource => resource.close()));
  }
}

module.exports = verify;
