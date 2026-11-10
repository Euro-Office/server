/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';
const {afterEach, beforeEach, expect, test} = require('@jest/globals');
const {randomUUID} = require('node:crypto');

// Never fall back to the developer's configured broker.
if (!process.env.EO_RABBITMQ_TEST_URL) {
  throw new Error('Run npm run test:rabbitmq to create a disposable RabbitMQ instance');
}
process.env.NODE_CONFIG = JSON.stringify({
  queue: {type: 'rabbitmq'},
  rabbitmq: {url: process.env.EO_RABBITMQ_TEST_URL}
});
const Queue = require('../../../Common/sources/taskqueueRabbitMQ');
const core = require('../../../Common/sources/rabbitMQCore');
const common = require('../../../Common/sources/commondefines');
const config = require('../../../Common/node_modules/config');
const {handleDeadLetter} = require('../../../DocService/sources/DocsCoServer');

const responseName = config.get('rabbitmq.queueconvertresponse.name');
const deadName = config.get('rabbitmq.queueconvertdead.name');
let queue;
let signals;

// Install before publishing/disconnecting so even immediate deliveries are observed.
function next(emitter, event) {
  let listener;
  let timer;
  const dispose = () => {
    clearTimeout(timer);
    emitter.removeListener(event, listener);
  };
  const result = new Promise((resolve, reject) => {
    listener = (...args) => {
      dispose();
      resolve(args);
    };
    emitter.once(event, listener);
    timer = setTimeout(() => {
      dispose();
      reject(new Error(`Timed out waiting for ${event}`));
    }, 10000);
  });
  result.catch(() => {});
  signals.push(dispose);
  return result;
}

function rpc(channel, method, ...args) {
  return new Promise((resolve, reject) => {
    channel[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function task() {
  const id = randomUUID();
  return new common.TaskQueueData({
    ctx: {tenant: 'localhost', docId: id, userId: 'user'},
    cmd: {
      c: 'sfc',
      id,
      savekey: `operation-${id}`,
      attempt: 4,
      callbackAttempt: 2,
      callbackAccepted: true,
      updateVersionPending: true,
      savedState: {success: true, claimed: true}
    }
  });
}

beforeEach(async () => {
  signals = [];
  queue = new Queue();
  await queue.initPromise(false, true, false, true, true, true);
  // Barrier after production's asynchronous dead-letter binding.
  await rpc(queue.channelConvertDead, 'checkQueue', deadName);
}, 15000);

afterEach(async () => {
  signals.forEach(dispose => dispose());
  queue.removeAllListeners();
  queue.isClose = true;
  // Closing the connection closes all channels, including unacknowledged consumers.
  if (queue.connection && !queue.connection.connection.stream.destroyed) {
    await core.closePromise(queue.connection);
  }
  // The runner removes the whole dedicated container/vhost, even on assertion failure.
});

test('confirmed final-save retry survives delayed expiry, dead-letter routing and response publication', async () => {
  const retry = task();
  const expected = JSON.parse(JSON.stringify(retry));
  const dead = next(queue, 'dead');
  const response = next(queue, 'response');

  await queue.addDelayed(retry, 100, true);
  const [data, ack, nack, live] = await dead;
  expect(JSON.parse(data)).toEqual(expected);
  expect(live()).toBe(true);

  // No HTTP server, SQL, Redis, storage or callback execution is needed for this branch.
  await handleDeadLetter(data, ack, nack, live, queue);
  const [body, acknowledge, isLive] = await response;
  expect(JSON.parse(body)).toEqual(expected);
  expect(isLive()).toBe(true);
  acknowledge();
  await rpc(queue.channelConvertResponseReceive, 'checkQueue', responseName);
  const status = await rpc(queue.channelConvertDead, 'checkQueue', deadName);
  expect(status.messageCount).toBe(0);
}, 15000);

test('connection loss redelivers a response; a stale callback cannot acknowledge its replacement', async () => {
  const retry = task();
  const expected = JSON.parse(JSON.stringify(retry));
  const first = next(queue, 'response');
  await queue.addResponse(retry, true);
  const [original, staleAck, staleLive] = await first;
  expect(JSON.parse(original)).toEqual(expected);
  const originalChannel = queue.channelConvertResponseReceive;

  // Destroy the actual consumer socket, leaving its delivery unacknowledged.
  const replacement = next(queue, 'response');
  queue.connection.connection.stream.destroy(new Error('integration test: consumer connection lost'));
  const [redelivered, _ack, replacementLive] = await replacement;
  expect(JSON.parse(redelivered)).toEqual(expected);
  expect(queue.channelConvertResponseReceive).not.toBe(originalChannel);
  expect(staleLive()).toBe(false);
  expect(replacementLive()).toBe(true);

  staleAck();
  // AMQP RPC on the same channel is a barrier after any accidental stale ack.
  await rpc(queue.channelConvertResponseReceive, 'checkQueue', responseName);
  expect(replacementLive()).toBe(true);

  // A second reconnect proves the stale callback did not silently settle the new tag.
  const stillUnsettled = next(queue, 'response');
  queue.connection.connection.stream.destroy(new Error('integration test: consumer connection lost'));
  const [again, ack, live] = await stillUnsettled;
  expect(JSON.parse(again)).toEqual(expected);
  expect(live()).toBe(true);
  ack();
  await rpc(queue.channelConvertResponseReceive, 'checkQueue', responseName);

  // Reconnect after the live ack. An unacked old delivery would arrive before
  // this sentinel, so this also verifies that the current callback settled correctly.
  const finalDelivery = next(queue, 'response');
  queue.connection.connection.stream.destroy(new Error('integration test: consumer connection lost'));
  // Publishing needs the replacement sender; the response sentinel is queued by a
  // separate production Queue rather than waiting on internal reconnect timing.
  const publisher = new Queue();
  try {
    await publisher.initPromise(false, true, false, false, false, false);
    await publisher.addResponse({sentinel: true}, true);
    const [last, lastAck] = await finalDelivery;
    expect(JSON.parse(last)).toEqual({sentinel: true});
    lastAck();
    await rpc(queue.channelConvertResponseReceive, 'checkQueue', responseName);
  } finally {
    await publisher.close();
  }
}, 15000);
