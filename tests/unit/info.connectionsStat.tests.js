'use strict';

// /info sums the connection samples that several DocService instances write in
// the same interval. With a shared Redis statistics store every instance sees
// the others' samples, so each one must be counted with its own value.
const assert = require('node:assert/strict');
const {afterEach, describe, jest, test} = require('@jest/globals');

// Load the route first, as the server does: it loads operationContext before
// tenantManager, which the two modules' circular require needs.
const {licenseInfo} = require('../../DocService/sources/routes/info');
const tenantManager = require('../../Common/sources/tenantManager');
const {EditorStat} = require('../../DocService/sources/editorDataMemory');
const {setDocumentsExpireStepMs} = require('../../DocService/sources/expirationConfig');

async function connectionsStat(samples) {
  jest.spyOn(tenantManager, 'getTenantLicense').mockResolvedValue([{}]);
  jest.spyOn(EditorStat.prototype, 'getEditorConnections').mockResolvedValue(samples);
  let body;
  const res = {
    headersSent: false,
    setHeader() {},
    status() {
      return this;
    },
    json(value) {
      body = value;
    },
    send(value) {
      body = typeof value === 'string' ? JSON.parse(value) : value;
    }
  };
  await licenseInfo({query: {}, headers: {host: 'localhost'}, get: () => undefined}, res);
  return body.connectionsStat.hour;
}

describe('/info connection statistics from several instances', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  for (const [name, values] of [
    ['the busy instance wrote last', [0, 10]],
    ['the idle instance wrote last', [10, 0]]
  ]) {
    test(`adds each instance's sample when ${name}`, async () => {
      const now = Date.now();
      const samples = values.map((edit, index) => ({time: now - 60000 + index * 10, edit, liveview: index, view: 2 * index}));

      const hour = await connectionsStat(samples);

      assert.equal(hour.edit.max, 10);
      assert.equal(hour.edit.min, 10);
      assert.equal(hour.liveview.max, 1);
      assert.equal(hour.view.max, 2);
    });
  }

  test('groups the samples by the refresh interval DocService really uses', async () => {
    // documentsCron is 2 minutes, but DocService shortened the interval to one
    // minute (too slow for the Redis TTLs): one instance, one sample a minute.
    setDocumentsExpireStepMs(60000);
    try {
      const now = Date.now();
      const samples = Array.from({length: 59}, (_, index) => ({time: now - (59 - index) * 60000, edit: 10, liveview: 0, view: 0}));

      const hour = await connectionsStat(samples);

      assert.equal(hour.edit.max, 10);
      assert.equal(hour.edit.min, 10);
      assert.ok(hour.edit.avr >= 9 && hour.edit.avr <= 10, `average ${hour.edit.avr}`);
    } finally {
      setDocumentsExpireStepMs(undefined);
    }
  });
});
