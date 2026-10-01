'use strict';

const operationContext = require('./../../Common/sources/operationContext');

// Reports Redis failures without drowning the log in them. Both stores
// swallow their errors by design, which left an outage looking healthy; but
// a broken deployment fails on every operation, so an error per catch hides
// the signal just as well. Log the transition, then a periodic reminder
// carrying the suppressed count, then the recovery.

const REPEAT_INTERVAL_MS = 60000;

function createFailureReporter(storeName) {
  let failing = false;
  let lastReportedAt = 0;
  let suppressed = 0;

  function logger(ctx) {
    return (ctx && ctx.logger) || operationContext.global.logger;
  }

  return {
    failure(ctx, operation, err) {
      const now = Date.now();
      suppressed++;
      if (failing && now - lastReportedAt < REPEAT_INTERVAL_MS) {
        return;
      }
      logger(ctx).error(
        '%s: Redis %s failed, degrading (%d failure(s) since last report): %s',
        storeName,
        operation,
        suppressed,
        (err && err.message) || err
      );
      failing = true;
      lastReportedAt = now;
      suppressed = 0;
    },

    success(ctx) {
      if (!failing) {
        return;
      }
      failing = false;
      suppressed = 0;
      logger(ctx).info('%s: Redis recovered', storeName);
    }
  };
}

module.exports = {createFailureReporter};
