'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeAll, describe, jest, test} = require('@jest/globals');

const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const storage = require('../../Common/sources/storage/storage-base');
const taskResult = require('../../DocService/sources/taskresult');
const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');
const {requireRedis} = require('./requireRedis');

jest.mock('../../DocService/sources/gc', () => ({
  getCronStep: () => 0,
  getDocumentsExpireStep: () => 0,
  checkFileExpire: jest.fn().mockResolvedValue(undefined)
}));

const previousDbKeysNum = process.env.REDIS_SERVER_DB_KEYS_NUM;
process.env.REDIS_SERVER_DB_KEYS_NUM = '1';
const docsCoServer = require('../../DocService/sources/DocsCoServer');
if (previousDbKeysNum === undefined) {
  delete process.env.REDIS_SERVER_DB_KEYS_NUM;
} else {
  process.env.REDIS_SERVER_DB_KEYS_NUM = previousDbKeysNum;
}

describe('DocsCoServer viewer disconnect cleanup', () => {
  beforeAll(async () => {
    await requireRedis('DocsCoServer.disconnect.tests.js');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not run terminal side effects while another replica has an editor', async () => {
    const data = new EditorData();
    const remoteData = new EditorData();
    const ctx = {
      ...context('viewer-disconnect-remote-presence'),
      logger: {debug() {}, error() {}, info() {}, warn() {}}
    };
    const docId = 'remote-presence-document';
    const select = jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    const restoreInitialPassword = jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    const deleteChanges = jest.spyOn(sqlBase, 'deleteChanges').mockImplementation(() => {});
    const deletePath = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockImplementation((...args) => data.cleanDocumentOnExit(...args));

    try {
      await remoteData.addPresence(ctx, docId, 'remote-editor', JSON.stringify({id: 'remote-editor', view: false}));

      assert.equal(await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, true), false);
      assert.equal(select.mock.calls.length, 0);
      assert.equal(restoreInitialPassword.mock.calls.length, 0);
      assert.equal(deleteChanges.mock.calls.length, 0);
      assert.equal(deletePath.mock.calls.length, 0);
    } finally {
      await remoteData.removePresence(ctx, docId, 'remote-editor');
      await data.cleanDocumentOnExit(ctx, docId);
      await remoteData.cleanDocumentOnExit(ctx, docId);
      await data.close();
      await remoteData.close();
    }
  });

  test('a viewer on another replica does not block the final save cleanup', async () => {
    const data = new EditorData();
    const remoteData = new EditorData();
    const ctx = {
      ...context('viewer-disconnect-remote-viewer'),
      logger: {debug() {}, error() {}, info() {}, warn() {}}
    };
    const docId = 'remote-viewer-document';
    const viewerInfo = JSON.stringify({id: 'remote-viewer', view: true});
    jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    const restoreInitialPassword = jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    const deleteChanges = jest.spyOn(sqlBase, 'deleteChangesPromise').mockResolvedValue(undefined);
    const deletePath = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockImplementation((...args) => data.cleanDocumentOnExit(...args));

    try {
      await remoteData.addPresence(ctx, docId, 'remote-viewer', viewerInfo);

      // Without a WOPI host the unlock step resolves true, so the whole
      // cleanup completes: the changes and the forgotten file are deleted.
      assert.equal(await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, true), true);
      assert.equal(restoreInitialPassword.mock.calls.length, 1);
      assert.equal(deleteChanges.mock.calls.length, 1);
      assert.equal(deletePath.mock.calls.length, 1);
      assert.deepEqual(await data.getPresence(ctx, docId), [viewerInfo]);
    } finally {
      await remoteData.removePresence(ctx, docId, 'remote-viewer');
      await data.cleanDocumentOnExit(ctx, docId);
      await data.close();
      await remoteData.close();
    }
  });

  test('does not run terminal side effects when Redis cleanup result is invalid', async () => {
    const data = new EditorData();
    const ctx = {
      ...context('viewer-disconnect-invalid-cleanup'),
      logger: {debug() {}, error() {}, info() {}, warn() {}}
    };
    const docId = 'invalid-cleanup-document';
    const select = jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    const restoreInitialPassword = jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    const deleteChanges = jest.spyOn(sqlBase, 'deleteChanges').mockImplementation(() => {});
    const deletePath = jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined);
    const deleteStat = jest.spyOn(docsCoServer.editorStatProxy, 'deleteKey').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockImplementation((...args) => data.cleanDocumentOnExit(...args));
    data._eval = async () => [1, undefined];

    try {
      await docsCoServer.preStop({method: 'PUT', headers: {host: 'localhost'}}, {setHeader() {}, send() {}});
      assert.equal(await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, true), false);
      assert.equal(select.mock.calls.length, 0);
      assert.equal(restoreInitialPassword.mock.calls.length, 0);
      assert.equal(deleteChanges.mock.calls.length, 0);
      assert.equal(deletePath.mock.calls.length, 0);
      assert.equal(deleteStat.mock.calls.length, 0);
    } finally {
      await docsCoServer.preStop({method: 'DELETE', headers: {host: 'localhost'}}, {setHeader() {}, send() {}});
      await data.cleanDocumentOnExit(ctx, docId);
      await data.close();
    }
  });
});
