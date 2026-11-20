'use strict';

require('../env-setup');

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');

const config = require('../../DocService/node_modules/config');
const {
  MAX_TIMER_DELAY_MS,
  cronStepMs,
  documentExpiryTtlsApply,
  maxSafeDocumentsStepMs,
  resolveDocumentExpiryStep,
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
      assert.equal(result.stepMs, 272727);
      assert.match(result.message, /runs every 7200 seconds/);
      assert.match(result.message, /Using an interval of 272\.727 seconds instead/);
      assert.equal(validateDocumentExpiryConfig({documentsCron: '*', presence: 300, shard: 300}, () => result.stepMs).valid, true);
    });

    test('uses the shorter of the presence and shard TTLs', () => {
      const result = resolveDocumentExpiryStep({documentsCron: '0 */5 * * * *', presence: 600, shard: 60}, () => 300000);

      assert.equal(result.clamped, true);
      assert.equal(result.stepMs, maxSafeDocumentsStepMs(60000, 60000));
      assert.ok(result.stepMs < 60000);
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
      // February 31 never comes; the next dates are leap-year February 29ths.
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

  test('maxSafeDocumentsStepMs returns the longest interval that passes the TTL rule', () => {
    for (const ttlMs of [2200, 3000, 10000, 60000, 110000, 300000, 1100000, 86400000]) {
      const stepMs = maxSafeDocumentsStepMs(ttlMs, ttlMs);
      const passes = step => validateDocumentExpiryConfig({documentsCron: '*', presence: ttlMs / 1000, shard: ttlMs / 1000}, () => step).valid;

      assert.ok(Number.isInteger(stepMs), `ttl ${ttlMs}`);
      assert.equal(passes(stepMs), true, `ttl ${ttlMs} step ${stepMs}`);
      assert.equal(passes(stepMs + 1), false, `ttl ${ttlMs} step ${stepMs + 1}`);
    }
    assert.ok(Number.isNaN(maxSafeDocumentsStepMs(2000, 2000)));
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
