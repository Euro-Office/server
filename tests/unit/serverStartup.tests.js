'use strict';

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');
const {startHttpServer} = require('../../DocService/sources/serverStartup');

const logger = {error() {}};

describe('HTTP server startup boundary', () => {
  test('starts listening only after Redis startup succeeds', () => {
    const listen = [];
    const server = {listen: (...args) => listen.push(args)};

    assert.equal(startHttpServer({server, startupError: undefined, logger, shutdown: async () => {}, port: 8080, onListening: () => {}}), true);
    assert.equal(listen.length, 1);
    assert.equal(listen[0][0], 8080);
  });

  test('does not listen and shuts down when Redis startup is exhausted', async () => {
    const listen = [];
    const shutdown = [];
    const exits = [];
    const server = {listen: (...args) => listen.push(args)};

    assert.equal(
      startHttpServer({
        server,
        startupError: new Error('Redis unavailable'),
        logger,
        shutdown: async (...args) => {
          shutdown.push(args);
          return 1;
        },
        exit: code => exits.push(code),
        port: 8080,
        onListening: () => {}
      }),
      false
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(listen, []);
    assert.deepEqual(shutdown, [['startup', 1]]);
    assert.deepEqual(exits, [1]);
  });
});
