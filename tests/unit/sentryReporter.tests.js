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
  flush: jest.fn(() => Promise.resolve(true)),
  close: jest.fn(() => Promise.resolve(true))
}));

const Sentry = require('../../Common/node_modules/@sentry/node');
const levels = require('../../Common/node_modules/log4js/lib/levels');
const logger = require('../../Common/sources/logger');
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

  test('tags tenant and docId from the log context, skipping placeholders', () => {
    appender({...logEvent('ERROR', 'save error'), context: {TENANT: 'nc.example', DOCID: 'abc123', USERID: 'u1'}});
    expect(Sentry.captureMessage.mock.calls[0][1].tags).toEqual({logger: 'nodeJS', tenant: 'nc.example', docId: 'abc123'});
    appender({...logEvent('ERROR', 'save error'), context: {TENANT: 'localhost', DOCID: 'docId', USERID: 'userId'}});
    expect(Sentry.captureMessage.mock.calls[1][1].tags).toEqual({logger: 'nodeJS', tenant: 'localhost'});
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

  test('groups stack-shaped arguments by template and error line', () => {
    appender(logEvent('ERROR', 'uncaughtException:%s', 'TypeError: x is undefined\n    at f (a.js:1:1)'));
    expect(Sentry.captureMessage.mock.calls[0][1].fingerprint).toEqual(['uncaughtException:%s', 'TypeError: x is undefined']);
  });

  test('passes Error objects through, grouped by template and stack', () => {
    const err = new Error('boom');
    appender(logEvent('FATAL', 'convert failed', err));
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({level: 'fatal', fingerprint: ['convert failed', '{{ default }}']})
    );
  });

  test('logger passes Errors on with only name, message, stack and code', () => {
    logger.configureLogger({});
    const err = Object.assign(new TypeError('Request failed'), {code: 'ECONNREFUSED', config: {headers: {Authorization: 'secret'}}});
    logger.getLogger('nodeJS').error('download error:', err);
    const [captured, {extra}] = Sentry.captureException.mock.calls[0];
    expect(captured).toMatchObject({name: 'TypeError', message: 'Request failed', stack: err.stack, code: 'ECONNREFUSED'});
    expect(captured.config).toBeUndefined();
    expect(extra.message).not.toContain('secret');
  });

  test('uses default grouping when the first argument is an Error', () => {
    appender(logEvent('ERROR', new Error('boom')));
    expect(Sentry.captureException.mock.calls[0][1].fingerprint).toBeUndefined();
  });

  test('scrubs tokens and reduces request data to method, url and query', () => {
    const event = reporter.scrub({
      message: 'GET https://nc/x?a=1&token=abc.def&doc=secret#h failed, Authorization: Bearer abc.def',
      request: {
        method: 'POST',
        url: 'https://ds/coauthoring/CommandService.ashx',
        query_string: 'token=abc',
        headers: {Authorization: 'Bearer abc', 'user-agent': 'ua'},
        cookies: {nc_session_id: 'secret'},
        data: '{"user":"alice"}'
      }
    });
    expect(event.message).toBe('GET https://nc/x?a=1&token=[Filtered]&doc=[Filtered]#h failed, Authorization: Bearer [Filtered]');
    expect(event.request).toEqual({method: 'POST', url: 'https://ds/coauthoring/CommandService.ashx', query_string: 'token=[Filtered]'});
  });

  test('scrubs WOPI access tokens, bare query strings and raw JWTs', () => {
    const event = reporter.scrub({
      message: 'error downloadFile:url=https://nc/wopi/files/1/contents?access_token=secret&x=1',
      breadcrumbs: [{data: {'http.query': 'token=secret&a=1'}}],
      extra: {data: '{"key":"k","token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_123"}', keep: 'mydoc=fine'}
    });
    expect(event.message).toBe('error downloadFile:url=https://nc/wopi/files/1/contents?access_token=[Filtered]&x=1');
    expect(event.breadcrumbs[0].data['http.query']).toBe('token=[Filtered]&a=1');
    expect(event.extra).toEqual({data: '{"key":"k","token":"[Filtered]"}', keep: 'mydoc=fine'});
  });

  test('shutdown flushes without closing, so reporting survives a log4js reconfigure', done => {
    appender.shutdown(() => {
      expect(Sentry.flush).toHaveBeenCalled();
      expect(Sentry.close).not.toHaveBeenCalled();
      appender(logEvent('ERROR', 'after reload'));
      expect(Sentry.captureMessage).toHaveBeenCalledWith('after reload', expect.anything());
      done();
    });
  });
});
