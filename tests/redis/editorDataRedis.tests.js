'use strict';

const assert = require('node:assert/strict');
const {test} = require('@jest/globals');

const verify = require('./editorDataRedis.verify');
const smoke = require('./editorDataRedis.pkg-smoke');

test('editorDataRedis implements the editor data contract', async () => {
  await verify();
}, 30000);

test('editorDataRedis can be loaded through the configured storage package', async () => {
  await smoke();
});

test('editorDataRedis resets the client after a command timeout', async () => {
  const {EditorData} = require('../../DocService/sources/editorDataRedis');
  const data = new EditorData();

  try {
    await data.connect();
    const client = data.redis.client;
    data.redis.commandTimeoutMs = 25;
    client.sendCommand = () => new Promise(() => {});

    await assert.rejects(data.ping(), error => error.code === 'ETIMEDOUT');
    assert.equal(data.isConnected(), false);
    assert.equal(data.redis.client, null);
    assert.equal(await data.ping(), 'PONG');
  } finally {
    await data.close();
  }
}, 10000);

test('editorDataRedis healthCheck reports command failures', async () => {
  const {EditorData} = require('../../DocService/sources/editorDataRedis');
  const data = new EditorData();

  try {
    await data.connect();
    const client = data.redis.client;
    const sendCommand = client.sendCommand;
    client.sendCommand = () => Promise.reject(new Error('simulated Redis failure'));
    assert.equal(await data.healthCheck(), false);
    client.sendCommand = sendCommand;
    assert.equal(await data.healthCheck(), true);
  } finally {
    await data.close();
  }
}, 10000);

test('editorDataRedis resets the client after a transaction timeout', async () => {
  if (process.env.TEST_REDIS_CLUSTER === 'true') {
    // Cluster commands are routed individually instead of through MULTI, so
    // this standalone-only transaction timeout cannot be exercised here.
    return;
  }

  const {EditorData} = require('../../DocService/sources/editorDataRedis');
  const data = new EditorData();

  try {
    await data.connect();
    const client = data.redis.client;
    data.redis.commandTimeoutMs = 25;
    client.multi = () => ({
      addCommand() {},
      exec: () => new Promise(() => {})
    });

    await assert.rejects(data._commands([['PING']]), error => error.code === 'ETIMEDOUT');
    assert.equal(data.isConnected(), false);
    assert.equal(data.redis.client, null);
    assert.equal(await data.ping(), 'PONG');
  } finally {
    await data.close();
  }
}, 10000);
