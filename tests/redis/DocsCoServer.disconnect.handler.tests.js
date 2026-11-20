'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeAll, beforeEach, describe, jest, test} = require('@jest/globals');
const {EditorData} = require('../../DocService/sources/editorDataRedis');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const storage = require('../../Common/sources/storage/storage-base');

const mockSocketIo = {connection: null};

jest.mock('../../DocService/node_modules/socket.io', () => ({
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
}));

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
    connections.push(editor.conn, viewer.conn);

    await mockSocketIo.connection(editor.conn);
    await mockSocketIo.connection(viewer.conn);
    await editor.handlers.disconnect('transport close');

    // The last editor's exit cleans up although a viewer remains (as the
    // in-memory backend does); only the viewer's presence and the documents
    // index entry for it are kept.
    assert.deepEqual(await isolatedEditorData.getPresence(ctx, docId), [viewerInfo]);
    assert.deepEqual(await readDocumentState(isolatedEditorData, ctx, docId), emptyDocumentState());
    assert.equal(docsCoServer.editorData.cleanDocumentOnExit.mock.calls.length, 1);
    assert.notEqual(await readDocumentIndexScore(isolatedEditorData, ctx, docId), null);

    // A final save still in flight writes the state it reads back later.
    await seedDocumentState(isolatedEditorData, ctx, docId);
    const stateWithEditorAndViewer = await readDocumentState(isolatedEditorData, ctx, docId);
    await viewer.handlers.disconnect('transport close');

    assert.deepEqual(await isolatedEditorData.getPresence(ctx, docId), []);
    assert.equal(await readPresenceKeyCount(isolatedEditorData, ctx, docId), 0);
    // Final-viewer cleanup can run while the last editor's final save is still
    // in flight, so it keeps the saved status and the force-save entry that
    // save reads (savedState.js contract) and removes everything else.
    assert.deepEqual(await readDocumentState(isolatedEditorData, ctx, docId), {
      ...emptyDocumentState(),
      saved: stateWithEditorAndViewer.saved,
      forceSave: stateWithEditorAndViewer.forceSave
    });
    assert.equal(await readDocumentIndexScore(isolatedEditorData, ctx, docId), null);
    assert.equal(docsCoServer.editorData.cleanDocumentOnExit.mock.calls.length, 2);
    assert.deepEqual(docsCoServer.editorData.cleanDocumentOnExit.mock.calls[1][3], {preserveSavedClaim: true});
  });

  test('the final viewer exit saves changes left by an editor whose process died', async () => {
    const ctx = context(tenantManager.getDefautTenant());
    const viewer = connectionHandlers({id: 'viewer-connection', userId: 'viewer', view: true});
    const docId = viewer.conn.docId;
    const deadEditorInfo = JSON.stringify({id: 'dead-editor', idOriginal: 'dead-editor', view: false, connectionId: 'dead-connection'});
    const viewerInfo = JSON.stringify({...viewer.conn.user, connectionId: viewer.conn.id});
    await isolatedEditorData.addPresence(ctx, docId, 'dead-editor', deadEditorInfo);
    await isolatedEditorData.addPresence(ctx, docId, viewer.conn.user.id, viewerInfo);
    // The editor's process died: its presence expired and was never removed,
    // while the viewer's refreshed presence kept the document out of GC.
    await isolatedEditorData._command(['ZADD', isolatedEditorData._docKeys(ctx, docId).presenceSet, '1', 'dead-editor']);
    connections.push(viewer.conn);
    jest.spyOn(sqlBase, 'getChangesIndexPromise').mockResolvedValue([{change_id: 4}]);
    // A save is already in progress or was just started by this exit.
    jest.spyOn(taskResult, 'select').mockResolvedValue([{callback: 'https://example.test/callback'}]);
    const updateIf = jest.spyOn(taskResult, 'updateIf').mockResolvedValue({affectedRows: 0});

    try {
      await mockSocketIo.connection(viewer.conn);
      await viewer.handlers.disconnect('transport close');

      assert.deepEqual(await isolatedEditorData.getPresence(ctx, docId), []);
      assert.equal(await readDocumentIndexScore(isolatedEditorData, ctx, docId), null);
      // The unsaved changes are sent to the save, not left behind.
      assert.equal(updateIf.mock.calls.length, 1);
      assert.equal(updateIf.mock.calls[0][2].key, docId);
      assert.equal(docsCoServer.editorData.cleanDocumentOnExit.mock.calls.length, 0);
    } finally {
      await isolatedEditorData.cleanDocumentOnExit(ctx, docId);
    }
  });

  test('an editor that sends "close" is counted as a viewer instead of an editor', async () => {
    const ctx = context(tenantManager.getDefautTenant());
    const editor = connectionHandlers({id: 'closing-editor-connection', userId: 'closing-editor', view: false});
    const docId = editor.conn.docId;
    await isolatedEditorData.addPresence(ctx, docId, editor.conn.user.id, JSON.stringify({...editor.conn.user, connectionId: editor.conn.id}));
    connections.push(editor.conn);
    const editorCounts = jest.spyOn(docsCoServer.editorStat, 'incrEditorConnectionsCountByShard').mockResolvedValue(undefined);
    jest.spyOn(docsCoServer.editorData, 'addPresence').mockImplementation((...args) => isolatedEditorData.addPresence(...args));

    try {
      await mockSocketIo.connection(editor.conn);
      await editor.handlers.message({type: 'close'});

      assert.equal(editor.conn.isCloseCoAuthoring, true);
      assert.deepEqual([...editorCounts.mock.calls.map(call => call[2])], [-1]);
      assert.deepEqual([...docsCoServer.editorStat.incrViewerConnectionsCountByShard.mock.calls.map(call => call[2])], [1]);
    } finally {
      await isolatedEditorData.removePresence(ctx, docId, editor.conn.user.id);
      await isolatedEditorData.cleanDocumentOnExit(ctx, docId);
    }
  });

  test('leaves editor data alone for sockets the server closes when it shuts down', async () => {
    const ctx = context(tenantManager.getDefautTenant());
    const editor = connectionHandlers({id: 'editor-connection', userId: 'editor', view: false});
    const docId = editor.conn.docId;
    const editorInfo = JSON.stringify({...editor.conn.user, connectionId: editor.conn.id});
    await isolatedEditorData.addPresence(ctx, docId, editor.conn.user.id, editorInfo);
    await seedDocumentState(isolatedEditorData, ctx, docId);
    const state = await readDocumentState(isolatedEditorData, ctx, docId);
    const indexScore = await readDocumentIndexScore(isolatedEditorData, ctx, docId);
    connections.push(editor.conn);
    await mockSocketIo.connection(editor.conn);

    try {
      // SIGTERM or a fatal error: the server closes Socket.IO, which
      // disconnects every socket with this reason.
      await docsCoServer.close();
      await editor.handlers.disconnect('server shutting down');

      // As after a killed process: the presence expires later and GC on
      // another instance saves or closes the document.
      assert.deepEqual(await isolatedEditorData.getPresence(ctx, docId), [editorInfo]);
      assert.deepEqual(await readDocumentState(isolatedEditorData, ctx, docId), state);
      assert.equal(await readDocumentIndexScore(isolatedEditorData, ctx, docId), indexScore);
      assert.equal(docsCoServer.editorData.removePresence.mock.calls.length, 0);
      assert.equal(docsCoServer.editorData.cleanDocumentOnExit.mock.calls.length, 0);
    } finally {
      await isolatedEditorData.removePresence(ctx, docId, editor.conn.user.id);
      await isolatedEditorData.cleanDocumentOnExit(ctx, docId);
    }
  });
});
