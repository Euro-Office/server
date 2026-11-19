/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {afterEach, describe, expect, jest, test} = require('@jest/globals');
const commonDefines = require('../../Common/sources/commondefines');
const constants = require('../../Common/sources/constants');
const converterService = require('../../DocService/sources/converterservice');
const docsCoServer = require('../../DocService/sources/DocsCoServer');
const taskResult = require('../../DocService/sources/taskresult');

const ctx = {tenant: 'force-save-test', getCfg: (_key, fallback) => fallback, logger: {debug() {}, warn() {}, error() {}}};
let nextId = 0;

describe('Form and Internal force-save status', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['Form', commonDefines.c_oAscForceSaveTypes.Form],
    ['Internal', commonDefines.c_oAscForceSaveTypes.Internal]
  ])('reports an active %s save', async (_name, type) => {
    const docId = `force-save-active-${++nextId}`;
    await docsCoServer.editorData.setForceSave(ctx, docId, 400, 12, 'https://example.test', {change: 'initial'}, null);
    await docsCoServer.editorData.checkAndStartForceSave(ctx, docId);

    const result = await docsCoServer.startForceSave(ctx, docId, type);

    expect(result).toMatchObject({code: commonDefines.c_oAscServerCommandErrors.NoError, time: null, inProgress: true});
  });

  test.each([
    ['Form', commonDefines.c_oAscForceSaveTypes.Form],
    ['Internal', commonDefines.c_oAscForceSaveTypes.Internal]
  ])('reports the losing concurrent %s request as in progress', async (_name, type) => {
    const docId = `force-save-concurrent-${++nextId}`;
    jest.spyOn(taskResult, 'selectWithCache').mockResolvedValue([]);
    jest.spyOn(converterService, 'convertFromChanges').mockResolvedValue({err: constants.NO_ERROR});
    await docsCoServer.editorData.setForceSave(ctx, docId, 401, 12, 'https://example.test', {change: 'initial'}, null);

    const results = await Promise.all([docsCoServer.startForceSave(ctx, docId, type), docsCoServer.startForceSave(ctx, docId, type)]);

    expect(results.filter(result => result.inProgress)).toHaveLength(1);
    expect(results.filter(result => result.time === 401)).toHaveLength(1);
    expect(results.every(result => result.code === commonDefines.c_oAscServerCommandErrors.NoError)).toBe(true);
  });
});
