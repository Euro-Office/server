'use strict';

require('../env-setup');

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const {
  MAX_TIMER_DELAY_MS,
  cronStepMs,
  documentExpiryTtlsApply,
  documentExpiryFromConfig,
  resolveDocumentExpiryStep,
  safeDocumentsStepMs,
  validateDocumentExpiryConfig
} = require('../../DocService/sources/expirationConfig');

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

  describe('resolveDocumentExpiryStep', () => {
    test('keeps a safe interval unchanged', () => {
      const result = resolveDocumentExpiryStep(defaultExpiryConfig());

      assert.equal(result.valid, true);
      assert.equal(result.clamped, false);
      assert.equal(result.stepMs, 120000);
    });

    test('shortens an interval that is too slow for the TTLs instead of rejecting it', () => {
      const result = resolveDocumentExpiryStep({documentsCron: '0 0 */2 * * *', presence: 300, shard: 300});

      assert.equal(result.valid, true);
      assert.equal(result.clamped, true);
      assert.equal(result.documentsCronStepMs, 7200000);
      assert.equal(result.stepMs, 120000);
      assert.match(result.message, /runs every 7200 seconds/);
      assert.match(result.message, /Using an interval of 120 seconds instead/);
      assert.equal(validateDocumentExpiryConfig({documentsCron: '*', presence: 300, shard: 300}, () => result.stepMs).valid, true);
    });

    test('uses the shorter of the presence and shard TTLs', () => {
      const result = resolveDocumentExpiryStep({documentsCron: '0 */5 * * * *', presence: 600, shard: 60}, () => 300000);

      assert.equal(result.clamped, true);
      // Half the shorter TTL, since that is shorter than the default interval.
      assert.equal(result.stepMs, 30000);
    });

    test('does not shorten when the TTL rule does not apply', () => {
      const result = resolveDocumentExpiryStep({documentsCron: '0 0 */2 * * *', presence: 300, shard: 300}, undefined, {checkTtls: false});

      assert.equal(result.clamped, false);
      assert.equal(result.stepMs, 7200000);
    });

    test('uses the default interval for a cron that cannot be parsed', () => {
      // Six fields pass the AdminPanel schema but are not a cron expression.
      const result = resolveDocumentExpiryStep({documentsCron: 'x x x x x x', presence: 300, shard: 300});

      assert.equal(result.valid, true);
      assert.equal(result.clamped, true);
      assert.equal(result.stepMs, 120000);
      assert.match(result.message, /Invalid services.CoAuthoring.expire.documentsCron/);
      assert.match(result.message, /Using the default interval of 120 seconds instead/);
    });

    test('caps an interval longer than a timer allows when the TTL rule does not apply', () => {
      // Once a year: "0 0 0 31 2 *" is 31 March (this cron library counts
      // months from 0).
      const result = resolveDocumentExpiryStep({documentsCron: '0 0 0 31 2 *', presence: 300, shard: 300}, () => 366 * 86400000, {
        checkTtls: false
      });

      assert.equal(result.clamped, true);
      assert.equal(result.stepMs, MAX_TIMER_DELAY_MS);
    });

    test('still rejects unusable TTLs', () => {
      assert.equal(resolveDocumentExpiryStep({documentsCron: '*/1 * * * * *', presence: 0, shard: 300}, () => 1000).valid, false);
      // 2 s TTLs leave no interval of at least one second with headroom.
      assert.equal(resolveDocumentExpiryStep({documentsCron: '*/5 * * * * *', presence: 2, shard: 2}, () => 5000).valid, false);
    });
  });

  test('safeDocumentsStepMs uses the default interval, or half the TTL when that is shorter', () => {
    assert.equal(safeDocumentsStepMs(300000, 300000), 120000);
    assert.equal(safeDocumentsStepMs(300000, 100000), 50000);
    assert.equal(safeDocumentsStepMs(3000, 3000), 1500);
    // Every result passes the rule with room left for the refresh pass.
    for (const ttlMs of [3000, 10000, 100000, 300000, 86400000]) {
      const stepMs = safeDocumentsStepMs(ttlMs, ttlMs);
      assert.equal(validateDocumentExpiryConfig({documentsCron: '*', presence: ttlMs / 1000, shard: ttlMs / 1000}, () => stepMs).valid, true);
    }
    assert.ok(Number.isNaN(safeDocumentsStepMs(2000, 2000)));
  });

  test('documentExpiryFromConfig resolves the interval from a config module as gc.js does', () => {
    const configModule = values => ({
      has: path => Object.hasOwn(values, path),
      get: path => values[path]
    });
    const slow = {
      'services.CoAuthoring.expire.documentsCron': '0 0 */2 * * *',
      'services.CoAuthoring.expire.presence': 300
    };

    // Redis editor data: shortened; an older config without expire.shard uses 300 s.
    const redis = documentExpiryFromConfig(configModule({...slow, 'services.CoAuthoring.server.editorDataStorage': 'editorDataRedis'}));
    assert.equal(redis.stepMs, 120000);
    assert.equal(redis.clamped, true);
    // In-memory editor data: kept as configured.
    const memory = documentExpiryFromConfig(configModule({...slow, 'services.CoAuthoring.server.editorDataStorage': 'editorDataMemory'}));
    assert.equal(memory.stepMs, 7200000);
    assert.equal(memory.clamped, false);
  });

  describe('cronStepMs', () => {
    test('keeps a valid interval', () => {
      assert.deepEqual(cronStepMs('0 */2 * * * *', 'documentsCron', 1000), {stepMs: 120000});
    });

    test('falls back for an expression that cannot be parsed or gives no interval', () => {
      for (const [cronTime, getStep, reason] of [
        ['x x x x x x', undefined, /Invalid filesCron/],
        ['', () => 0, /must produce a positive interval/],
        ['', () => NaN, /must produce a positive interval/]
      ]) {
        const result = cronStepMs(cronTime, 'filesCron', 3600000, getStep);
        assert.equal(result.stepMs, 3600000);
        assert.match(result.message, reason);
        assert.match(result.message, /Using the default interval of 3600 seconds instead/);
      }
    });

    test('caps an interval longer than a timer allows', () => {
      const result = cronStepMs('0 0 0 31 2 *', 'filesCron', 3600000, () => MAX_TIMER_DELAY_MS + 1);

      assert.equal(result.stepMs, MAX_TIMER_DELAY_MS);
      assert.match(result.message, /longer than a timer allows/);
    });
  });
});
