/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, jest, beforeAll, afterAll} = require('@jest/globals');

jest.mock('../../Common/node_modules/@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  close: jest.fn(() => Promise.resolve(true))
}));

const Sentry = require('../../Common/node_modules/@sentry/node');
const levels = require('../../Common/node_modules/log4js/lib/levels');
const reporters = require('../../Common/sources/reporters');
const reporter = require('../../Common/sources/reporters/sentry');

const logEvent = (level, ...data) => ({level: levels.getLevel(level), categoryName: 'nodeJS', data});

describe('sentry reporter', () => {
  let appender;
  let options;

  beforeAll(() => {
    expect(reporters.appenders()).toEqual({});
    process.env.SENTRY_DSN = 'http://key@localhost/1';
    reporters.init('docservice');
    options = Sentry.init.mock.calls[0][0];
    appender = reporter.configure({}, null, null, levels);
  });

  afterAll(() => {
    delete process.env.SENTRY_DSN;
  });

  test('init uses release default and drops the SDK crash handlers', () => {
    expect(options.sendDefaultPii).toBe(false);
    expect(options.initialScope).toEqual({tags: {service: 'docservice'}});
    expect(options.release).toMatch(/^documentserver@/);
    const names = options.integrations([{name: 'Http'}, {name: 'OnUncaughtException'}, {name: 'OnUnhandledRejection'}]).map(i => i.name);
    expect(names).toEqual(['Http']);
    expect(reporters.appenders()).toEqual({sentry: {type: reporter}});
  });

  test('ignores events below error', () => {
    appender(logEvent('WARN', 'warning %s', 'x'));
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('groups messages by format template', () => {
    appender(logEvent('ERROR', 'open error: %s', 'stack 1'));
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'open error: stack 1',
      expect.objectContaining({level: 'error', fingerprint: ['open error: %s']})
    );
  });

  test('passes Error objects through', () => {
    const err = new Error('boom');
    appender(logEvent('FATAL', 'convert failed', err));
    expect(Sentry.captureException).toHaveBeenCalledWith(err, expect.objectContaining({level: 'fatal', fingerprint: ['convert failed']}));
  });

  test('uses default grouping when the first argument is an Error', () => {
    appender(logEvent('ERROR', new Error('boom')));
    expect(Sentry.captureException.mock.calls[0][1].fingerprint).toBeUndefined();
  });

  test('scrubs tokens, doc params and authorization headers', () => {
    const event = reporter.scrub({
      message: 'GET https://nc/x?a=1&token=abc.def&doc=secret#h failed, Authorization: Bearer abc.def',
      request: {headers: {Authorization: 'Bearer abc', 'user-agent': 'ua'}}
    });
    expect(event.message).toBe('GET https://nc/x?a=1&token=[Filtered]&doc=[Filtered]#h failed, Authorization: Bearer [Filtered]');
    expect(event.request.headers).toEqual({Authorization: '[Filtered]', 'user-agent': 'ua'});
  });

  test('shutdown flushes the SDK', done => {
    appender.shutdown(() => {
      expect(Sentry.close).toHaveBeenCalled();
      done();
    });
  });
});
