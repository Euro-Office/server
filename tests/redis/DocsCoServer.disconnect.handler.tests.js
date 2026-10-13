'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeAll, beforeEach, describe, jest, test} = require('@jest/globals');
const {EditorData} = require('../../DocService/sources/editorDataRedis');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const storage = require('../../Common/sources/storage/storage-base');

const mockSocketIo = {connection: null};

jest.mock(
  'socket.io',
  () => ({
    Server: class {
      constructor() {
        this.engine = {on: jest.fn()};
      }

      use() {}

      on(event, callback) {
        if (event === 'connection') {
          mockSocketIo.connection = callback;
        }
      }

      close() {
        return Promise.resolve();
      }
    }
  }),
  {virtual: true}
);

jest.mock(
  '../../DocService/sources/pubsubRabbitMQ',
  () =>
    class {
      on() {}

      init() {}

      publish() {
        return Promise.resolve();
      }
    }
);

const docsCoServer = require('../../DocService/sources/DocsCoServer');
const tenantManager = require('../../Common/sources/tenantManager');
const taskResult = require('../../DocService/sources/taskresult');
const {context} = require('./testHelpers');
const {emptyDocumentState, readDocumentIndexScore, readDocumentState, readPresenceKeyCount, seedDocumentState} = require('./documentStateHelpers');
const {requireRedis} = require('./requireRedis');

function connectionHandlers({id, userId, view}) {
  const handlers = {};
  const conn = {
    docId: 'document',
    docid: 'document',
    handshake: {query: {}, url: '/doc/document'},
    id,
    on(event, callback) {
      handlers[event] = callback;
    },
    request: {headers: {host: 'localhost'}},
    user: {id: userId, idOriginal: userId, view},
    emit() {}
  };
  return {conn, handlers};
}

function redirectEditorDataMethods(isolatedEditorData) {
  for (const method of [
    'removePresence',
    'getPresence',
    'removePresenceDocument',
    'cleanDocumentOnExit',
    'unlockSave',
    'unlockAuth',
    'getLocks',
    'removeLocks'
  ]) {
    jest.spyOn(docsCoServer.editorData, method).mockImplementation((...args) => isolatedEditorData[method](...args));
  }
}

describe('DocsCoServer viewer disconnect handler', () => {
  let isolatedEditorData;
  let connections;

  beforeAll(async () => {
    await requireRedis('DocsCoServer.disconnect.handler.tests.js');
  });

  beforeEach(() => {
    isolatedEditorData = new EditorData();
    connections = docsCoServer.getConnections();
    connections.length = 0;
    docsCoServer.install({}, {}, () => {});
    // Keep the production disconnect handler and cleanup logic intact while
    // routing its editor-data calls to an isolated Redis-backed test store.
    redirectEditorDataMethods(isolatedEditorData);
    jest.spyOn(docsCoServer.editorStat, 'incrViewerConnectionsCountByShard').mockResolvedValue(undefined);
    jest.spyOn(tenantManager, 'getTenantLicense').mockResolvedValue([{type: 0, mode: 0}]);
    jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockResolvedValue([]);
    jest.spyOn(storage, 'listObjects').mockResolvedValue([]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    docsCoServer.getConnections().length = 0;
    await docsCoServer.close();
    if (isolatedEditorData) {
      await isolatedEditorData.close();
    }
  });

  test('runs production disconnect cleanup against isolated editor data', async () => {
    const ctx = context(tenantManager.getDefautTenant());
    const editor = connectionHandlers({id: 'editor-connection', userId: 'editor', view: false});
    const viewer = connectionHandlers({id: 'viewer-connection', userId: 'viewer', view: true});
    const docId = editor.conn.docId;
    const editorInfo = JSON.stringify({...editor.conn.user, connectionId: editor.conn.id});
    const viewerInfo = JSON.stringify({...viewer.conn.user, connectionId: viewer.conn.id});
    await isolatedEditorData.addPresence(ctx, docId, editor.conn.user.id, editorInfo);
    await isolatedEditorData.addPresence(ctx, docId, viewer.conn.user.id, viewerInfo);
    await seedDocumentState(isolatedEditorData, ctx, docId);
    const stateWithEditorAndViewer = await readDocumentState(isolatedEditorData, ctx, docId);
    connections.push(editor.conn, viewer.conn);

    await mockSocketIo.connection(editor.conn);
    await mockSocketIo.connection(viewer.conn);
    await editor.handlers.disconnect('transport close');

    assert.deepEqual(await isolatedEditorData.getPresence(ctx, docId), [viewerInfo]);
    assert.deepEqual(await readDocumentState(isolatedEditorData, ctx, docId), stateWithEditorAndViewer);
    assert.equal(docsCoServer.editorData.cleanDocumentOnExit.mock.calls.length, 1);
    assert.notEqual(await readDocumentIndexScore(isolatedEditorData, ctx, docId), null);

    await viewer.handlers.disconnect('transport close');

    assert.deepEqual(await isolatedEditorData.getPresence(ctx, docId), []);
    assert.equal(await readPresenceKeyCount(isolatedEditorData, ctx, docId), 0);
    assert.deepEqual(await readDocumentState(isolatedEditorData, ctx, docId), emptyDocumentState());
    assert.equal(await readDocumentIndexScore(isolatedEditorData, ctx, docId), null);
    assert.equal(docsCoServer.editorData.cleanDocumentOnExit.mock.calls.length, 2);
  });
});
