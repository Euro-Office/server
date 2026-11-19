'use strict';

require('../env-setup');

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const {documentExpiryTtlsApply, validateDocumentExpiryConfig} = require('../../DocService/sources/expirationConfig');

function defaultExpiryConfig() {
  const expire = config.get('services.CoAuthoring.expire');
  return {
    documentsCron: expire.get('documentsCron'),
    presence: expire.get('presence'),
    shard: expire.get('shard')
  };
}

describe('document expiry configuration', () => {
  test('applies the TTL rule only when editor data or editor stat uses a Redis backend', () => {
    assert.equal(documentExpiryTtlsApply('editorDataMemory', ''), false);
    assert.equal(documentExpiryTtlsApply('editorDataMemory', 'editorDataMemory'), false);
    assert.equal(documentExpiryTtlsApply('editorDataRedis', ''), true);
    assert.equal(documentExpiryTtlsApply('editorDataMemory', 'editorDataRedis'), true);
    assert.equal(documentExpiryTtlsApply('editorDataRedis', 'editorDataMemory'), true);
  });

  test('accepts a long cron interval when the TTL rule does not apply', () => {
    const result = validateDocumentExpiryConfig({documentsCron: '0 0 */2 * * *', presence: 300, shard: 300}, undefined, {checkTtls: false});

    assert.deepEqual(result, {valid: true, documentsCronStepMs: 7200000});
  });

  test('still rejects an invalid cron expression when the TTL rule does not apply', () => {
    const result = validateDocumentExpiryConfig({documentsCron: 'not a cron', presence: 300, shard: 300}, undefined, {checkTtls: false});

    assert.equal(result.valid, false);
    assert.match(result.message, /Invalid services.CoAuthoring.expire.documentsCron/);
  });

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
