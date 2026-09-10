'use strict';

const operationContext = require('./../../Common/sources/operationContext');

// Reports Redis failures without drowning the log in them.
//
// Both stores swallow their Redis errors by design - locks fail closed,
// presence fails open - which left a total save outage looking like a
// healthy deployment with an empty log. But a broken deployment fails on
// *every* operation, hundreds a minute, so an unconditional error per catch
// is just a different way of hiding the signal.
//
// So: log the transition into failure at error level (that is the line worth
// alerting on), stay quiet while it persists apart from a periodic
// reminder carrying the suppressed count, and log the recovery.

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
