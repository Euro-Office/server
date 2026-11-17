/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {afterEach, describe, expect, jest, test} = require('@jest/globals');
const config = require('../../DocService/node_modules/config');
const utils = require('../../Common/sources/utils');
const storage = require('../../Common/sources/storage/storage-base');
const sqlBase = require('../../DocService/sources/databaseConnectors/baseConnector');
const taskResult = require('../../DocService/sources/taskresult');
const docsCoServer = require('../../DocService/sources/DocsCoServer');

const ctx = {tenant: 'localhost', getCfg: (_key, fallback) => fallback, logger: {debug() {}, info() {}, warn() {}, error() {}}};
const docId = 'document-id';
const forgottenDir = config.get('services.CoAuthoring.server.forgottenfiles');
const forgottenName = config.get('services.CoAuthoring.server.forgottenfilesname');
const forgottenFile = `${docId}/${forgottenName}.docx`;
const forgottenPartialFile = `${docId}/${utils.getForgottenPartialName(forgottenName)}.docx`;

afterEach(() => jest.restoreAllMocks());

describe('save on close of the last editor', () => {
  test.each([
    ['an empty forgotten folder', [], false],
    ['only the partial output in forgotten', [forgottenPartialFile], false],
    ['a regular forgotten file', [forgottenFile], true],
    ['a regular forgotten file and the partial output', [forgottenPartialFile, forgottenFile], true]
  ])('without changes and with %s', async (_name, forgottenList, expected) => {
    const listObjects = jest.spyOn(storage, 'listObjects').mockResolvedValue(forgottenList);

    await expect(docsCoServer.needSaveOnClose(ctx, docId, false)).resolves.toBe(expected);
    expect(listObjects).toHaveBeenCalledWith(ctx, docId, forgottenDir);
  });

  test('with changes, without looking at forgotten', async () => {
    const listObjects = jest.spyOn(storage, 'listObjects');

    await expect(docsCoServer.needSaveOnClose(ctx, docId, true)).resolves.toBe(true);
    expect(listObjects).not.toHaveBeenCalled();
  });
});

describe('forgotten files after a successful save', () => {
  function mockCleanup(forgottenList) {
    jest.spyOn(docsCoServer.editorData, 'cleanDocumentOnExit').mockResolvedValue(true);
    jest.spyOn(taskResult, 'restoreInitialPassword').mockResolvedValue(undefined);
    jest.spyOn(taskResult, 'select').mockResolvedValue([]);
    jest.spyOn(sqlBase, 'deleteChanges').mockReturnValue(undefined);
    jest.spyOn(sqlBase, 'deleteChangesPromise').mockResolvedValue(undefined);
    jest.spyOn(storage, 'listObjects').mockResolvedValue(forgottenList);
    return {
      deletePath: jest.spyOn(storage, 'deletePath').mockResolvedValue(undefined),
      deleteObject: jest.spyOn(storage, 'deleteObject').mockResolvedValue(undefined)
    };
  }

  test('deletes the forgotten folder when it has no partial output', async () => {
    const {deletePath, deleteObject} = mockCleanup([forgottenFile]);

    await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, true);

    expect(deletePath).toHaveBeenCalledWith(ctx, docId, forgottenDir);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  test('keeps the partial output and deletes the regular file', async () => {
    const {deletePath, deleteObject} = mockCleanup([forgottenPartialFile, forgottenFile]);

    await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, true);

    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith(ctx, forgottenFile, forgottenDir);
    expect(deletePath).not.toHaveBeenCalled();
  });

  test('keeps the partial output when it is the only file', async () => {
    const {deletePath, deleteObject} = mockCleanup([forgottenPartialFile]);

    await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, true);

    expect(deleteObject).not.toHaveBeenCalled();
    expect(deletePath).not.toHaveBeenCalled();
  });

  test('does not touch forgotten when the changes are kept', async () => {
    const {deletePath, deleteObject} = mockCleanup([forgottenPartialFile, forgottenFile]);

    await docsCoServer.cleanDocumentOnExitPromise(ctx, docId, false);

    expect(storage.listObjects).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deletePath).not.toHaveBeenCalled();
  });
});
