const {describe, test, expect, jest} = require('@jest/globals');
const {createFailureReporter} = require('../../DocService/sources/editorDataRedisReport');

// The stores swallow their Redis errors by design, so this reporter is the
// only operational signal that a deployment has degraded. It has to be loud
// enough to alert on and quiet enough not to bury itself: the deployment that
// reported the original outage was failing every operation, hundreds a minute.
describe('editorDataRedisReport', () => {
  function ctxWithLogger() {
    return {logger: {error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn()}};
  }

  test('logs the transition into failure at error level', () => {
    const ctx = ctxWithLogger();
    const report = createFailureReporter('store');
    report.failure(ctx, 'lock', new Error('ECONNREFUSED'));
    expect(ctx.logger.error).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error.mock.calls[0].join(' ')).toContain('ECONNREFUSED');
  });

  test('stays quiet while the failure persists, rather than one line per operation', () => {
    const ctx = ctxWithLogger();
    const report = createFailureReporter('store');
    for (let i = 0; i < 500; i++) {
      report.failure(ctx, 'lock', new Error('ECONNREFUSED'));
    }
    expect(ctx.logger.error).toHaveBeenCalledTimes(1);
  });

  test('repeats once the interval elapses, carrying the count it suppressed', () => {
    const ctx = ctxWithLogger();
    const report = createFailureReporter('store');
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(0);
      report.failure(ctx, 'lock', new Error('boom'));
      for (let i = 0; i < 9; i++) {
        report.failure(ctx, 'lock', new Error('boom'));
      }
      expect(ctx.logger.error).toHaveBeenCalledTimes(1);

      now.mockReturnValue(60000);
      report.failure(ctx, 'lock', new Error('boom'));
      expect(ctx.logger.error).toHaveBeenCalledTimes(2);
      // 9 suppressed since the first report, plus the one being reported now.
      expect(ctx.logger.error.mock.calls[1]).toContain(10);
    } finally {
      now.mockRestore();
    }
  });

  test('logs recovery once, and only if it had reported a failure', () => {
    const ctx = ctxWithLogger();
    const report = createFailureReporter('store');

    report.success(ctx);
    expect(ctx.logger.info).not.toHaveBeenCalled();

    report.failure(ctx, 'lock', new Error('boom'));
    report.success(ctx);
    report.success(ctx);
    expect(ctx.logger.info).toHaveBeenCalledTimes(1);
  });

  // The regression that motivated splitting the sweep onto its own reporter:
  // one instance seeing an interleaved failure and success - a failing
  // docExpSweep.track() inside an otherwise successful presence write -
  // defeats the throttle entirely and logs two lines per heartbeat.
  test('an alternating failure/success stream re-arms the throttle every time', () => {
    const ctx = ctxWithLogger();
    const shared = createFailureReporter('shared');
    for (let i = 0; i < 20; i++) {
      shared.failure(ctx, 'track', new Error('boom'));
      shared.success(ctx);
    }
    expect(ctx.logger.error).toHaveBeenCalledTimes(20);
    expect(ctx.logger.info).toHaveBeenCalledTimes(20);

    // Two reporters, one per concern, is what keeps each throttle intact.
    const ctx2 = ctxWithLogger();
    const opReport = createFailureReporter('op');
    const sweepReport = createFailureReporter('sweep');
    for (let i = 0; i < 20; i++) {
      sweepReport.failure(ctx2, 'track', new Error('boom'));
      opReport.success(ctx2);
    }
    expect(ctx2.logger.error).toHaveBeenCalledTimes(1);
    expect(ctx2.logger.info).not.toHaveBeenCalled();
  });

  test('falls back to the global logger when there is no context', () => {
    const report = createFailureReporter('store');
    expect(() => report.failure(null, 'claimExpired', new Error('boom'))).not.toThrow();
  });
});
