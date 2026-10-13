'use strict';

require('../env-setup');

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const {validateDocumentExpiryConfig} = require('../../DocService/sources/expirationConfig');

function defaultExpiryConfig() {
  const expire = config.get('services.CoAuthoring.expire');
  return {
    documentsCron: expire.get('documentsCron'),
    presence: expire.get('presence'),
    shard: expire.get('shard')
  };
}

describe('document expiry configuration', () => {
  test('accepts the existing default documents cron and TTLs', () => {
    const result = validateDocumentExpiryConfig(defaultExpiryConfig());

    assert.equal(result.valid, true);
    assert.equal(result.documentsCronStepMs, 120000);
    assert.equal(result.presenceTtlMs, 300000);
    assert.equal(result.shardTtlMs, 300000);
  });

  test('rejects a cron interval equal to the presence TTL', () => {
    const result = validateDocumentExpiryConfig({documentsCron: '0 */5 * * * *', presence: 300, shard: 600}, () => 300000);

    assert.equal(result.valid, false);
    assert.match(result.message, /must be shorter than both the presence and shard TTLs with scheduling headroom/);
    assert.equal(result.presenceTtlMs, 300000);
    assert.equal(result.shardTtlMs, 600000);
  });

  test('rejects a cron interval equal to the shard TTL', () => {
    const result = validateDocumentExpiryConfig({documentsCron: '0 */5 * * * *', presence: 600, shard: 300}, () => 300000);

    assert.equal(result.valid, false);
    assert.match(result.message, /must be shorter than both the presence and shard TTLs with scheduling headroom/);
  });

  test('rejects a cron interval longer than the presence TTL', () => {
    const result = validateDocumentExpiryConfig({documentsCron: '0 */6 * * * *', presence: 300, shard: 600}, () => 360000);

    assert.equal(result.valid, false);
    assert.match(result.message, /runs every 360 seconds/);
  });

  test('accepts intervals with scheduling headroom below both TTL boundaries', () => {
    const result = validateDocumentExpiryConfig({documentsCron: '*/1 * * * * *', presence: 3, shard: '3s'}, () => 1999);

    assert.equal(result.valid, true);
    assert.equal(result.documentsCronStepMs, 1999);
    assert.equal(result.presenceTtlMs, 3000);
    assert.equal(result.shardTtlMs, 3000);
  });

  test('rejects non-positive TTLs', () => {
    const result = validateDocumentExpiryConfig({documentsCron: '*/1 * * * * *', presence: 0, shard: 300}, () => 1000);

    assert.equal(result.valid, false);
    assert.match(result.message, /must be positive durations/);
  });
});
