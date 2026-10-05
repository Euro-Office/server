'use strict';

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');
const {StartupRedisCancelledError, connectRedisForStartup} = require('../../DocService/sources/startupRedis');

const logger = {error() {}, warn() {}};

describe('Redis startup recovery', () => {
  test('recovers after an initial editor-data connection failure', async () => {
    let dataAttempts = 0;
    let statAttempts = 0;
    await connectRedisForStartup({
      editorData: {
        connect: async () => {
          dataAttempts++;
          if (dataAttempts === 1) {
            throw new Error('Redis unavailable');
          }
        }
      },
      editorStat: {connect: async () => statAttempts++},
      logger,
      retryDelayMs: 0
    });
    assert.equal(dataAttempts, 2);
    assert.equal(statAttempts, 1);
  });

  test('reports failure after the bounded retry policy is exhausted', async () => {
    let attempts = 0;
    const startup = connectRedisForStartup({
      editorData: {
        connect: async () => {
          attempts++;
          throw new Error('Redis unavailable');
        }
      },
      editorStat: {connect: async () => {}},
      logger,
      maxAttempts: 3,
      retryDelayMs: 0
    });
    await assert.rejects(startup, /Redis unavailable/);
    assert.equal(attempts, 3);
  });

  test.each([0, -1, 1.5, Infinity, NaN])('rejects invalid maxAttempts: %p', async maxAttempts => {
    let attempts = 0;
    const startup = connectRedisForStartup({
      editorData: {connect: async () => attempts++},
      editorStat: {connect: async () => {}},
      logger,
      maxAttempts,
      retryDelayMs: 0
    });
    await assert.rejects(startup, /maxAttempts must be a positive safe integer/);
    assert.equal(attempts, 0);
  });

  test.each([-1, Infinity, NaN, '100'])('rejects invalid retryDelayMs: %p', async retryDelayMs => {
    let attempts = 0;
    const startup = connectRedisForStartup({
      editorData: {connect: async () => attempts++},
      editorStat: {connect: async () => {}},
      logger,
      maxAttempts: 1,
      retryDelayMs
    });
    await assert.rejects(startup, /retryDelayMs must be a finite non-negative number/);
    assert.equal(attempts, 0);
  });

  test('recovers when editor-stat becomes available', async () => {
    let statAttempts = 0;
    await connectRedisForStartup({
      editorData: {connect: async () => {}},
      editorStat: {
        connect: async () => {
          statAttempts++;
          if (statAttempts < 3) {
            throw new Error('editor-stat unavailable');
          }
        }
      },
      logger,
      retryDelayMs: 0
    });
    assert.equal(statAttempts, 3);
  });

  test('cancels a pending retry without starting another Redis connection', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const startup = connectRedisForStartup({
      editorData: {
        connect: async () => {
          attempts++;
          throw new Error('Redis unavailable');
        }
      },
      editorStat: {connect: async () => {}},
      logger,
      signal: controller.signal,
      retryDelayMs: 1000
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(startup, StartupRedisCancelledError);
    assert.equal(attempts, 1);
  });

  test('cancels an in-flight Redis connection attempt', async () => {
    const controller = new AbortController();
    let cancelCalls = 0;
    const startup = connectRedisForStartup({
      editorData: {
        connect: () => new Promise(() => {}),
        cancelConnect: () => cancelCalls++
      },
      editorStat: {connect: async () => {}},
      logger,
      signal: controller.signal
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(startup, StartupRedisCancelledError);
    assert.equal(cancelCalls, 1);
  });
});
