/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect} = require('@jest/globals');
const constants = require('../../Common/sources/constants');
const metrics = require('../../Common/sources/metrics');
const canvasService = require('../../DocService/sources/canvasservice');

const completed = async result => (await metrics.conversionsCompleted.get()).values.find(v => v.labels.result === result)?.value ?? 0;

const receive = statusInfo =>
  new Promise(resolve => {
    const task = {ctx: {tenant: 'localhost', docId: 'doc'}, cmd: {c: 'conv', id: 'doc', status_info: statusInfo}};
    canvasService.receiveTask(JSON.stringify(task), resolve);
  });

describe('receiveTask', () => {
  test('counts conversion results by status', async () => {
    await receive(constants.NO_ERROR);
    await receive(constants.CONVERT);
    expect(await completed('ok')).toBe(1);
    expect(await completed('error')).toBe(1);
  });
});
