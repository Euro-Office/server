'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {afterEach, beforeEach, describe, test} = require('@jest/globals');

const commonDefines = require('../../Common/sources/commondefines');
const docsCoServer = require('../../DocService/sources/DocsCoServer');
const {EditorData} = require('../../DocService/sources/editorDataRedis');
const {context} = require('./testHelpers');

describe('DocsCoServer force-save command path', () => {
  let data;

  beforeEach(() => {
    data = new EditorData();
  });

  afterEach(async () => {
    await data.close();
  });

  test('reports UnknownError when a competing command cannot reset an active force-save', async () => {
    const ctx = {
      ...context('docs-co-server-force-save'),
      logger: {debug() {}, warn() {}, error() {}}
    };
    const docId = 'document';

    await data.setForceSave(ctx, docId, 400, 12, 'https://example.test', {change: 'initial'}, {failed: true});
    assert.ok(await data.checkAndStartForceSave(ctx, docId));

    const result = await docsCoServer.startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Command);

    assert.equal(result.code, commonDefines.c_oAscServerCommandErrors.UnknownError);
    assert.equal(result.time, null);
    assert.equal(result.inProgress, false);
  });
});
