/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';
const {afterEach, beforeEach, describe, expect, jest, test} = require('@jest/globals');
const {channel} = require('./helpers/queueBroker');
// Select ActiveMQ only in this test module's Jest registry.
const config = require('../../Common/node_modules/config');
jest.doMock('../../Common/node_modules/config', () => ({
  get: key => (key === 'queue.type' ? 'activemq' : config.get(key)),
  util: config.util
}));
const core = require('../../Common/sources/activeMQCore');
const Queue = require('../../Common/sources/taskqueueRabbitMQ');
jest.dontMock('../../Common/node_modules/config');
const docs = require('../../DocService/sources/DocsCoServer');
const canvas = require('../../DocService/sources/canvasservice');
const operationContext = require('../../Common/sources/operationContext');
const log4js = require('../../Common/node_modules/log4js');
let queue;
let links;
let disconnect;
beforeEach(async () => {
  jest.useFakeTimers();
  links = [];
  jest.spyOn(core, 'connetPromise').mockImplementation(async callback => {
    disconnect = callback;
    return {};
  });
  for (const method of ['openSenderPromise', 'openReceiverPromise']) {
    jest.spyOn(core, method).mockImplementation(async (_conn, options) => {
      const link = channel();
      link.options = options;
      link.send.mockImplementation(() => ({id: link.send.mock.calls.length}));
      links.push(link);
      return link;
    });
  }
  queue = new Queue();
  await queue.initPromise(false, true, false, true, true, true);
});
afterEach(() => {
  queue.isClose = true;
  disconnect();
  queue.removeAllListeners();
  links.forEach(link => link.removeAllListeners());
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
function publish(method) {
  return method === 'addResponse' ? queue.addResponse({}, true) : queue.addDelayed({}, 100, true);
}
function delivery(receiver, body = '{}') {
  const context = {message: {body}, delivery: {accept: jest.fn(), release: jest.fn()}};
  receiver.emit('message', context);
  return context.delivery;
}

describe('ActiveMQ consumers', () => {
  test('response credit caps outstanding deliveries at 16 and replenishes the window on settlement', () => {
    const receiver = queue.channelConvertResponseReceive;
    expect(receiver.options).toMatchObject({credit_window: 0, autoaccept: false});
    const callbacks = [];
    queue.on('response', (_body, ack) => callbacks.push(ack));
    let sent = 0;
    const available = () => receiver.add_credit.mock.calls.reduce((sum, [n]) => sum + n, 0) - sent;
    const deliveries = [];
    while (available() > 0) {
      sent++;
      deliveries.push(delivery(receiver));
      if (sent > 16) {
        throw new Error('unbounded response credit');
      }
    }
    expect(sent).toBe(16);
    expect(available()).toBe(0);
    deliveries.forEach(item => expect(item.accept).not.toHaveBeenCalled());
    callbacks.shift()();
    expect(available()).toBe(1);
    expect(deliveries[0].accept).toHaveBeenCalledTimes(1);
    sent++;
    deliveries.push(delivery(receiver));
    expect(available()).toBe(0);
    callbacks.forEach(ack => ack());
    deliveries.forEach(item => expect(item.accept).toHaveBeenCalledTimes(1));
    expect(available()).toBe(1);
    // An empty window can fill again without exceeding the limit.
    while (available() > 0 && callbacks.length < 32) {
      sent++;
      delivery(receiver);
    }
    expect(callbacks).toHaveLength(32);
    expect(available()).toBe(0);
    callbacks.slice(16).forEach(ack => ack());
  });

  test('a retained response cannot accept through a replacement receiver', async () => {
    const receiver = queue.channelConvertResponseReceive;
    let ack;
    let live;
    queue.on('response', (_body, callback, isLive) => {
      ack = callback;
      live = isLive;
    });
    const old = [delivery(receiver)];
    for (let i = 1; i < 16; i++) {
      old.push(delivery(receiver));
    }
    disconnect();
    expect(live()).toBe(false);
    await jest.advanceTimersByTimeAsync(core.RECONNECT_TIMEOUT);
    expect(queue.channelConvertResponseReceive).not.toBe(receiver);
    receiver.add_credit.mockImplementation(() => {
      throw new Error('link detached');
    });
    expect(() => ack()).not.toThrow();
    old.forEach(item => expect(item.accept).not.toHaveBeenCalled());
    let nextAck;
    queue.removeAllListeners('response');
    queue.on('response', (_body, callback) => {
      nextAck = callback;
    });
    const next = delivery(queue.channelConvertResponseReceive);
    nextAck();
    expect(next.accept).toHaveBeenCalledTimes(1);
    old.forEach(item => expect(item.accept).not.toHaveBeenCalled());
  });

  test('a dead-letter handler does not publish fallback retries after ActiveMQ connection loss', async () => {
    jest.spyOn(operationContext.Context.prototype, 'initTenantCache').mockResolvedValue(undefined);
    const logger = Object.getPrototypeOf(log4js.getLogger('active-dead-letter-test'));
    for (const level of ['debug', 'info', 'warn', 'error']) {
      jest.spyOn(logger, level).mockImplementation(() => {});
    }
    const abandon = jest.spyOn(canvas, 'abandonSfcRetry').mockResolvedValue(undefined);
    const receiver = queue.channelConvertDead;
    const response = queue.channelConvertResponse;
    const delayed = queue.channelDelayed;
    let processing;
    let live;
    queue.on('dead', (data, ack, nack, isLive) => {
      live = isLive;
      processing = docs.handleDeadLetter(data, ack, nack, isLive, queue);
    });
    const old = delivery(
      receiver,
      JSON.stringify({
        ctx: {tenant: 'localhost', docId: 'active-dead-letter', userId: 'user'},
        cmd: {c: 'sfc', id: 'active-dead-letter', savekey: 'save', attempt: 1}
      })
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(live()).toBe(true);
    expect(response.send).toHaveBeenCalledTimes(1);
    disconnect();
    expect(live()).toBe(false);
    await jest.advanceTimersByTimeAsync(core.RECONNECT_TIMEOUT);
    await processing;
    expect(delayed.send).not.toHaveBeenCalled();
    expect(queue.channelDelayed.send).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(old.accept).not.toHaveBeenCalled();
    expect(old.release).not.toHaveBeenCalled();
  });

  test('persistent dead-letter abandonment stops releasing after 30 requeues', async () => {
    jest.spyOn(operationContext.Context.prototype, 'initTenantCache').mockResolvedValue(undefined);
    jest
      .spyOn(operationContext.Context.prototype, 'getCfg')
      .mockImplementation((key, fallback) => (key === 'services.CoAuthoring.callbackBackoffOptions' ? {infraRetries: 0} : fallback));
    const logger = Object.getPrototypeOf(log4js.getLogger('active-terminal-test'));
    for (const level of ['debug', 'info', 'warn', 'error']) {
      jest.spyOn(logger, level).mockImplementation(() => {});
    }
    const abandon = jest.spyOn(canvas, 'abandonSfcRetry').mockRejectedValue(new Error('persistent terminal failure'));
    const receiver = queue.channelConvertDead;
    const response = queue.channelConvertResponse;
    let processing;
    queue.on('dead', (data, ack, nack, isLive) => {
      processing = docs.handleDeadLetter(data, ack, nack, isLive, queue);
    });
    const body = JSON.stringify({
      ctx: {tenant: 'localhost', docId: 'active-terminal', userId: 'user'},
      cmd: {c: 'sfc', id: 'active-terminal', savekey: 'save', attempt: 1}
    });
    const deliveries = [];
    for (let i = 0; i < 65; i++) {
      const item = delivery(receiver, body);
      deliveries.push(item);
      await jest.advanceTimersByTimeAsync(0);
      if (i === 0) {
        response.emit('rejected', {delivery: {id: 1, remote_state: {error: 'unavailable'}}});
      }
      await jest.advanceTimersByTimeAsync(2000);
      await processing;
      if (item.release.mock.calls.length === 0) {
        break;
      }
    }
    expect(deliveries).toHaveLength(31);
    expect(abandon).toHaveBeenCalledTimes(31);
    expect(response.send).toHaveBeenCalledTimes(1);
    expect(queue.channelDelayed.send).not.toHaveBeenCalled();
    deliveries.forEach(item => expect(item.accept).not.toHaveBeenCalled());
    deliveries.slice(0, 30).forEach(item => expect(item.release).toHaveBeenCalledTimes(1));
    expect(deliveries.at(-1).release).not.toHaveBeenCalled();
    expect(receiver.add_credit).toHaveBeenCalledTimes(31);
    await jest.advanceTimersByTimeAsync(3600000);
    expect(abandon).toHaveBeenCalledTimes(31);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['accept', 'release'])('stale dead-letter %s cannot settle or restore credit on a detached receiver', async method => {
    const receiver = queue.channelConvertDead;
    let settle;
    queue.on('dead', (_body, ack, nack) => {
      settle = method === 'accept' ? ack : nack;
    });
    const old = delivery(receiver);
    disconnect();
    await jest.advanceTimersByTimeAsync(core.RECONNECT_TIMEOUT);
    const replacement = queue.channelConvertDead;
    expect(replacement).not.toBe(receiver);
    receiver.add_credit.mockImplementation(() => {
      throw new Error('link detached');
    });
    expect(() => settle()).not.toThrow();
    expect(old.accept).not.toHaveBeenCalled();
    expect(old.release).not.toHaveBeenCalled();
    expect(receiver.add_credit).toHaveBeenCalledTimes(1);
    expect(replacement.add_credit.mock.calls).toEqual([[1]]);
  });

  test.each(['accept', 'release'])('dead-letter %s restores one credit on its own receiver', method => {
    const receiver = queue.channelConvertDead;
    queue.on('dead', (_body, ack, nack) => (method === 'accept' ? ack : nack)());
    const item = delivery(receiver);
    expect(item[method]).toHaveBeenCalledTimes(1);
    expect(item[method === 'accept' ? 'release' : 'accept']).not.toHaveBeenCalled();
    expect(receiver.add_credit.mock.calls).toEqual([[1], [1]]);
  });
});

describe('ActiveMQ confirmed publishing', () => {
  test.each(['addResponse', 'addDelayed'])('%s rejects when send returns no delivery', async method => {
    const sender = method === 'addResponse' ? queue.channelConvertResponse : queue.channelDelayed;
    sender.send.mockReturnValue(undefined);
    await expect(publish(method)).rejects.toThrow('message was not sent');
    expect(queue.channelConvertResponseData).toEqual({});
    expect(queue.channelDelayedData).toEqual({});
  });

  test.each(['accepted', 'rejected', 'released', 'modified'])('%s settles only the matching publish', async event => {
    for (const [method, field] of [
      ['addResponse', 'channelConvertResponse'],
      ['addDelayed', 'channelDelayed']
    ]) {
      const sender = queue[field];
      const first = publish(method);
      let secondSettled = false;
      const second = publish(method).then(() => {
        secondSettled = true;
      });
      let settled = false;
      const result = first.then(
        () => {
          settled = true;
          return 'accepted';
        },
        error => {
          settled = true;
          return error;
        }
      );
      sender.emit('accepted', {delivery: {id: 999}});
      await Promise.resolve();
      expect(settled).toBe(false);
      sender.emit(event, {delivery: {id: 1, remote_state: {error: 'denied', delivery_failed: true, undeliverable_here: true}}});
      if (event === 'accepted') {
        expect(await result).toBe('accepted');
      } else {
        const detail = event === 'rejected' ? 'error=denied' : 'delivery_failed=true, undeliverable_here=true';
        expect(await result).toEqual(new Error(`[AMQP] message is ${event} (${detail})`));
      }
      expect(secondSettled).toBe(false);
      expect(Object.keys(queue[`${field}Data`])).toEqual(['2']);
      sender.emit('accepted', {delivery: {id: 2}});
      await second;
      expect(queue[`${field}Data`]).toEqual({});
    }
  });

  test('late settlement on a lost sender cannot settle a replacement sender publication with the same ID', async () => {
    const lostSender = queue.channelConvertResponse;
    const failed = expect(queue.addResponse({}, true)).rejects.toThrow('connection lost');
    disconnect();
    await failed;
    await jest.advanceTimersByTimeAsync(core.RECONNECT_TIMEOUT);
    const replacement = queue.channelConvertResponse;
    expect(replacement).not.toBe(lostSender);
    let settled = false;
    const pending = queue.addResponse({}, true).then(() => {
      settled = true;
    });
    lostSender.emit('accepted', {delivery: {id: 1}});
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(Object.keys(queue.channelConvertResponseData)).toEqual(['1']);
    replacement.emit('accepted', {delivery: {id: 1}});
    await pending;
    expect(settled).toBe(true);
    expect(queue.channelConvertResponseData).toEqual({});
  });

  test('connection loss rejects pending publishes and removes their old bookkeeping', async () => {
    const oldMaps = [queue.channelConvertResponseData, queue.channelDelayedData];
    const response = expect(queue.addResponse({}, true)).rejects.toThrow('connection lost');
    const delayed = expect(queue.addDelayed({}, 100, true)).rejects.toThrow('connection lost');
    queue.isClose = true;
    disconnect();
    await Promise.all([response, delayed]);
    expect(queue.channelConvertResponseData).toEqual({});
    expect(queue.channelDelayedData).toEqual({});
    oldMaps.forEach(map => expect(map).toEqual({}));
  });
});
