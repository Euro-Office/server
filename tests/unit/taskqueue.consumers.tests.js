/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';
const {afterEach, beforeEach, describe, expect, jest, test} = require('@jest/globals');
const Queue = require('../../Common/sources/taskqueueRabbitMQ');
const core = require('../../Common/sources/rabbitMQCore');
const {rabbit, channel} = require('./helpers/queueBroker');

let queue;
let broker;
beforeEach(() => {
  jest.useFakeTimers();
  broker = rabbit(core);
  queue = new Queue();
});
afterEach(() => {
  queue.removeAllListeners();
  for (const source of broker.channels) {
    source.removeAllListeners();
  }
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('RabbitMQ consumer settlement', () => {
  test.each(['response', 'dead'])('%s acknowledges on the delivering channel', async event => {
    await queue.initPromise(false, false, false, true, true, false);
    const source = event === 'response' ? queue.channelConvertResponseReceive : queue.channelConvertDead;
    const other = event === 'response' ? queue.channelConvertDead : queue.channelConvertResponseReceive;
    let ack;
    queue.on(event, (_data, callback) => {
      ack = callback;
    });
    const message = broker.deliver(source);
    expect(source.ack).not.toHaveBeenCalled();
    ack();
    expect(source.ack).toHaveBeenCalledTimes(1);
    expect(source.ack).toHaveBeenCalledWith(message);
    expect(source.nack).not.toHaveBeenCalled();
    expect(other.ack).not.toHaveBeenCalled();
  });

  test.each(['response', 'dead'])('%s retained callbacks cannot settle on a replacement', async event => {
    await queue.initPromise(false, false, false, true, true, false);
    const field = event === 'response' ? 'channelConvertResponseReceive' : 'channelConvertDead';
    const source = queue[field];
    let ack;
    let third;
    queue.on(event, (_data, callback, last) => {
      ack = callback;
      third = last;
    });
    broker.deliver(source);
    queue[field] = channel();
    ack();
    if (event === 'response') {
      expect(third()).toBe(false);
    } else {
      third();
    }
    for (const receiver of [source, queue[field]]) {
      expect(receiver.ack).not.toHaveBeenCalled();
      expect(receiver.nack).not.toHaveBeenCalled();
    }
  });

  test.each(['response', 'dead'])('%s observes channel closure while the connection stays up', async event => {
    await queue.initPromise(false, false, false, true, true, false);
    const source = event === 'response' ? queue.channelConvertResponseReceive : queue.channelConvertDead;
    const connection = queue.connection;
    let ack;
    let third;
    queue.on(event, (_data, callback, last) => {
      ack = callback;
      third = last;
    });
    broker.deliver(source);
    source.emit('close');
    expect(queue.connection).toBe(connection);
    ack();
    if (event === 'response') {
      expect(third()).toBe(false);
    } else {
      third();
    }
    expect(source.ack).not.toHaveBeenCalled();
    expect(source.nack).not.toHaveBeenCalled();
  });

  test('live dead-letter requeue rejects just that delivery and asks the broker to requeue it', async () => {
    await queue.initPromise(false, false, false, false, true, false);
    queue.on('dead', (_data, _ack, nack) => nack());
    const message = broker.deliver(queue.channelConvertDead);
    expect(queue.channelConvertDead.nack).toHaveBeenCalledTimes(1);
    expect(queue.channelConvertDead.nack).toHaveBeenCalledWith(message, false, true);
    expect(queue.channelConvertDead.ack).not.toHaveBeenCalled();
  });

  test('connection loss invalidates a retained response callback and reconnects through initialization', async () => {
    await queue.initPromise(false, false, false, true, false, false);
    const source = queue.channelConvertResponseReceive;
    let ack;
    let live;
    queue.on('response', (_data, callback, isLive) => {
      ack = callback;
      live = isLive;
    });
    broker.deliver(source);
    broker.disconnect();
    expect(live()).toBe(false);
    await jest.advanceTimersByTimeAsync(core.RECONNECT_TIMEOUT);
    const replacement = queue.channelConvertResponseReceive;
    expect(replacement).not.toBe(source);
    expect(replacement).not.toBeNull();
    ack();
    expect(source.ack).not.toHaveBeenCalled();
    expect(replacement.ack).not.toHaveBeenCalled();
  });
});
