/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';
const {afterEach, beforeEach, describe, expect, jest, test} = require('@jest/globals');
const docs = require('../../DocService/sources/DocsCoServer');
const canvas = require('../../DocService/sources/canvasservice');
const Queue = require('../../Common/sources/taskqueueRabbitMQ');
const core = require('../../Common/sources/rabbitMQCore');
const common = require('../../Common/sources/commondefines');
const constants = require('../../Common/sources/constants');
const operationContext = require('../../Common/sources/operationContext');
const config = require('../../Common/node_modules/config');
const log4js = require('../../Common/node_modules/log4js');
const {rabbit} = require('./helpers/queueBroker');
let queue;
let broker;
let confirms;
let options;
let id = 0;
let docId;
let ack;
let nack;
const logger = Object.getPrototypeOf(log4js.getLogger('dead-letter-tests'));
function task(overrides = {}, fields = {}) {
  return JSON.stringify({
    ctx: {tenant: 'localhost', docId, userId: 'user'},
    cmd: {
      c: 'sfc',
      id: docId,
      savekey: 'operation',
      attempt: 4,
      callbackAttempt: 2,
      callbackAccepted: true,
      savedState: {success: true, claimId: 'claim'},
      ...overrides
    },
    ...fields
  });
}
function run(data, requeue = nack) {
  return docs.handleDeadLetter(data, ack, requeue, undefined, queue);
}
async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}
async function failBoth(data = task(), requeue = nack) {
  const pending = run(data, requeue);
  await flush();
  confirms.shift()(new Error('response unavailable'));
  await flush();
  if (confirms.length) {
    confirms.shift()(new Error('delay unavailable'));
  }
  await jest.advanceTimersByTimeAsync(2000);
  await pending;
}
beforeEach(async () => {
  jest.useFakeTimers();
  docId = `dead-letter-${++id}`;
  confirms = [];
  ack = jest.fn();
  nack = jest.fn();
  options = {...config.get('services.CoAuthoring.callbackBackoffOptions')};
  jest.spyOn(operationContext.Context.prototype, 'initTenantCache').mockResolvedValue(undefined);
  jest
    .spyOn(operationContext.Context.prototype, 'getCfg')
    .mockImplementation((key, fallback) => (key === 'services.CoAuthoring.callbackBackoffOptions' ? options : fallback));
  for (const level of ['debug', 'info', 'warn', 'error']) {
    jest.spyOn(logger, level).mockImplementation(() => {});
  }
  jest.spyOn(canvas, 'abandonSfcRetry').mockResolvedValue(undefined);
  broker = rabbit(core);
  queue = new Queue();
  await queue.initPromise(false, true, false, false, true, true);
  for (const sender of [queue.channelConvertResponse, queue.channelDelayed]) {
    sender.sendToQueue.mockImplementation((_name, _body, _options, confirm) => confirms.push(confirm));
  }
});
afterEach(() => {
  try {
    expect(confirms).toHaveLength(0);
  } finally {
    queue.removeAllListeners();
    broker.channels.forEach(source => source.removeAllListeners());
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

describe('dead-letter confirmed recovery', () => {
  test('acknowledges only after response confirmation and preserves the entire task', async () => {
    const data = task();
    const pending = run(data);
    await flush();
    expect(ack).not.toHaveBeenCalled();
    const [, body, properties] = queue.channelConvertResponse.sendToQueue.mock.calls[0];
    expect(JSON.parse(body)).toEqual(JSON.parse(data));
    expect(properties).toEqual({persistent: true});
    confirms.shift()(null);
    await pending;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
    expect(queue.channelDelayed.sendToQueue).not.toHaveBeenCalled();
  });

  test.each([
    [3, 2, 2000],
    [4, 2, 4000],
    [10, 2, 8000]
  ])('response failure falls back to confirmed delay: attempt %d, HTTP count %d', async (attempt, callbackAttempt, delay) => {
    const data = task({attempt, callbackAttempt});
    const pending = run(data);
    await flush();
    confirms.shift()(new Error('response rejected'));
    await flush();
    expect(ack).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
    const [, body, properties] = queue.channelDelayed.sendToQueue.mock.calls[0];
    const expected = JSON.parse(data);
    expected.cmd.attempt++;
    expect(JSON.parse(body)).toEqual(expected);
    expect(properties).toEqual({persistent: true, expiration: String(delay)});
    confirms.shift()(null);
    await pending;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
    expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
  });

  test('both failures retain the original for a delayed nack on the delivering channel', async () => {
    let pending;
    const source = queue.channelConvertDead;
    queue.on('dead', (data, settle, reject, isLive) => {
      pending = docs.handleDeadLetter(data, settle, reject, isLive, queue);
    });
    const message = broker.deliver(source, task());
    await flush();
    confirms.shift()(new Error('response failed'));
    await flush();
    confirms.shift()(new Error('delay failed'));
    await flush();
    expect(source.ack).not.toHaveBeenCalled();
    expect(source.nack).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1999);
    expect(source.nack).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(source.ack).not.toHaveBeenCalled();
    expect(source.nack).toHaveBeenCalledTimes(1);
    expect(source.nack).toHaveBeenCalledWith(message, false, true);
    expect(JSON.parse(message.content).cmd.attempt).toBe(4);
  });

  test('persistent failure abandons on the 31st delivery within this process, then clears its counter', async () => {
    const data = task();
    for (let i = 0; i < 30; i++) {
      await failBoth(data);
    }
    expect(nack).toHaveBeenCalledTimes(30);
    expect(ack).not.toHaveBeenCalled();
    expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
    await failBoth(data);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
    expect(canvas.abandonSfcRetry.mock.calls[0][1]).toMatchObject({attempt: 5, callbackAttempt: 2});
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledTimes(30);
    await failBoth(data);
    expect(nack).toHaveBeenCalledTimes(31);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
  });

  test.each(['response', 'delay'])('%s success clears previous requeue bookkeeping', async route => {
    const data = task();
    for (let i = 0; i < 30; i++) {
      await failBoth(data);
    }
    const pending = run(data);
    await flush();
    confirms.shift()(route === 'response' ? null : new Error('response failed'));
    if (route === 'delay') {
      await flush();
      confirms.shift()(null);
    }
    await pending;
    await failBoth(data);
    expect(nack).toHaveBeenCalledTimes(31);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
  });

  test('budget exhaustion waits for abandonment, settles once, and clears prior requeues', async () => {
    const data = task();
    for (let i = 0; i < 30; i++) {
      await failBoth(data);
    }
    options.infraRetries = 2;
    let abandoned;
    canvas.abandonSfcRetry.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          abandoned = resolve;
        })
    );
    const pending = run(data);
    await flush();
    confirms.shift()(new Error('response failed'));
    await flush();
    expect(ack).not.toHaveBeenCalled();
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
    expect(confirms).toHaveLength(0);
    abandoned();
    await pending;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledTimes(30);
    options.infraRetries = 60;
    await failBoth(data);
    expect(nack).toHaveBeenCalledTimes(31);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
  });

  test('confirmed delayed retries carry the infrastructure budget across rounds', async () => {
    options.infraRetries = 4;
    let data = task({attempt: 2, callbackAttempt: 2});
    for (const delay of [1000, 2000, 4000, 8000]) {
      const pending = run(data);
      await flush();
      confirms.shift()(new Error('response failed'));
      await flush();
      const [, body, properties] = queue.channelDelayed.sendToQueue.mock.calls.at(-1);
      expect(properties.expiration).toBe(String(delay));
      data = body.toString();
      expect(JSON.parse(data).cmd.callbackAttempt).toBe(2);
      confirms.shift()(null);
      await pending;
    }
    const pending = run(data);
    await flush();
    confirms.shift()(new Error('response failed'));
    await pending;
    expect(queue.channelDelayed.sendToQueue).toHaveBeenCalledTimes(4);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
    expect(canvas.abandonSfcRetry.mock.calls[0][1]).toMatchObject({attempt: 6, callbackAttempt: 2});
    expect(ack).toHaveBeenCalledTimes(5);
    expect(nack).not.toHaveBeenCalled();
  });

  test('a final save stays unsettled when recovery fails without requeue support', async () => {
    await failBoth(task(), null);
    expect(ack).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });

  test.each(['{', '{}'])('malformed message %s is logged and acknowledged', async data => {
    await run(data);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('handleDeadLetter error: %s', expect.any(String));
  });

  test('tenant initialization failure requeues the unchanged final save and a redelivery can recover', async () => {
    const data = task();
    operationContext.Context.prototype.initTenantCache.mockRejectedValueOnce(new Error('tenant unavailable'));
    const pending = run(data);
    await flush();
    expect(ack).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
    expect(queue.channelConvertResponse.sendToQueue).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2000);
    await pending;
    expect(nack).toHaveBeenCalledTimes(1);
    expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
    const redelivery = run(data);
    await flush();
    expect(JSON.parse(queue.channelConvertResponse.sendToQueue.mock.calls[0][1])).toEqual(JSON.parse(data));
    confirms.shift()(null);
    await redelivery;
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('persistent tenant failures reach abandonment within the process-local requeue limit', async () => {
    const data = task();
    operationContext.Context.prototype.initTenantCache.mockRejectedValue(new Error('tenant unavailable'));
    for (let i = 0; i < 31; i++) {
      const pending = run(data);
      await jest.advanceTimersByTimeAsync(2000);
      await pending;
    }
    expect(nack).toHaveBeenCalledTimes(30);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(queue.channelConvertResponse.sendToQueue).not.toHaveBeenCalled();
    expect(queue.channelDelayed.sendToQueue).not.toHaveBeenCalled();
    const next = run(data);
    await jest.advanceTimersByTimeAsync(2000);
    await next;
    expect(nack).toHaveBeenCalledTimes(31);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
  });

  test('failed abandonment retains the delivery and retries only abandonment until it succeeds', async () => {
    options.infraRetries = 2;
    canvas.abandonSfcRetry.mockRejectedValueOnce(new Error('abandonment failed'));
    const data = task();
    const pending = run(data);
    await flush();
    confirms.shift()(new Error('response failed'));
    await jest.advanceTimersByTimeAsync(2000);
    await pending;
    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledTimes(1);
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(1);
    const redelivery = run(data);
    await flush();
    await redelivery;
    expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(2);
    expect(queue.channelConvertResponse.sendToQueue).toHaveBeenCalledTimes(1);
    expect(queue.channelDelayed.sendToQueue).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledTimes(1);
  });

  test.each(['budget', 'publishes', 'tenant'])(
    'persistent abandonment failure after %s exhaustion stops requeueing and preserves the delivery',
    async failure => {
      const data = task();
      if (failure === 'budget') {
        options.infraRetries = 2;
      }
      if (failure === 'tenant') {
        operationContext.Context.prototype.initTenantCache.mockRejectedValue(new Error('tenant unavailable'));
      }
      canvas.abandonSfcRetry.mockRejectedValue(new Error('persistent terminal failure'));
      let pending;
      queue.on('dead', (body, settle, reject, isLive) => {
        pending = docs.handleDeadLetter(body, settle, reject, isLive, queue);
      });
      const source = queue.channelConvertDead;
      let held;
      for (let delivered = 0; delivered < 65; delivered++) {
        const requeues = source.nack.mock.calls.length;
        held = broker.deliver(source, data);
        await flush();
        while (confirms.length) {
          confirms.shift()(new Error('publish failed'));
          await flush();
        }
        await jest.advanceTimersByTimeAsync(2000);
        await pending;
        if (source.nack.mock.calls.length === requeues) {
          break;
        }
      }
      expect(source.nack).toHaveBeenCalledTimes(30);
      expect(source.ack).not.toHaveBeenCalled();
      expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(failure === 'budget' ? 31 : 1);
      expect(held.content.toString()).toBe(data);
      expect(source.nack.mock.calls.some(([message]) => message === held)).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'handleDeadLetter: automatic requeues exhausted; delivery remains unacknowledged for broker redelivery'
      );
      const attempts = canvas.abandonSfcRetry.mock.calls.length;
      await jest.advanceTimersByTimeAsync(3600000);
      expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(attempts);
      expect(source.nack).toHaveBeenCalledTimes(30);
      expect(jest.getTimerCount()).toBe(0);

      // A later connection recovery can redeliver the held message and finish abandonment.
      source.emit('close');
      queue.isClose = true;
      broker.disconnect();
      await queue.initPromise(false, true, false, false, true, true);
      operationContext.Context.prototype.initTenantCache.mockResolvedValue(undefined);
      canvas.abandonSfcRetry.mockResolvedValue(undefined);
      const replacement = queue.channelConvertDead;
      const redelivered = broker.deliver(replacement, data);
      await flush();
      await pending;
      expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(attempts + 1);
      expect(replacement.ack).toHaveBeenCalledTimes(1);
      expect(replacement.ack).toHaveBeenCalledWith(redelivered);
      expect(replacement.nack).not.toHaveBeenCalled();
      expect(source.ack).not.toHaveBeenCalled();
      expect(queue.channelConvertResponse.sendToQueue).not.toHaveBeenCalled();
      expect(queue.channelDelayed.sendToQueue).not.toHaveBeenCalled();

      // Successful abandonment clears the terminal marker.
      queue.channelConvertResponse.sendToQueue.mockImplementation((_name, _body, _options, confirm) => confirms.push(confirm));
      const fresh = run(data);
      await flush();
      expect(confirms).toHaveLength(1);
      confirms.shift()(null);
      await fresh;
      expect(ack).toHaveBeenCalledTimes(1);
      expect(canvas.abandonSfcRetry).toHaveBeenCalledTimes(attempts + 1);
    }
  );

  test.each(['response', 'delay', 'budget', 'tenant', 'nack wait'])(
    'channel closure during %s recovery suppresses stale publications, abandonment and settlement',
    async phase => {
      const source = queue.channelConvertDead;
      let pending;
      let live;
      queue.on('dead', (data, settle, reject, isLive) => {
        live = isLive;
        pending = docs.handleDeadLetter(data, settle, reject, isLive, queue);
      });
      let releaseTenant;
      if (phase === 'tenant') {
        operationContext.Context.prototype.initTenantCache.mockImplementationOnce(
          () =>
            new Promise(resolve => {
              releaseTenant = resolve;
            })
        );
      }
      if (phase === 'budget') {
        options.infraRetries = 2;
      }
      broker.deliver(source, task());
      await flush();
      if (phase === 'delay' || phase === 'nack wait') {
        confirms.shift()(new Error('response failed'));
        await flush();
        expect(queue.channelDelayed.sendToQueue).toHaveBeenCalledTimes(1);
        if (phase === 'nack wait') {
          confirms.shift()(new Error('delay failed'));
          await flush();
        }
      }
      source.emit('close');
      expect(live()).toBe(false);
      if (phase === 'tenant') {
        releaseTenant();
      }
      while (confirms.length) {
        confirms.shift()(new Error('confirmation failed'));
      }
      await jest.advanceTimersByTimeAsync(2000);
      await pending;
      expect(queue.channelDelayed.sendToQueue).toHaveBeenCalledTimes(phase === 'delay' || phase === 'nack wait' ? 1 : 0);
      expect(queue.channelConvertResponse.sendToQueue).toHaveBeenCalledTimes(phase === 'tenant' ? 0 : 1);
      expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
      expect(source.ack).not.toHaveBeenCalled();
      expect(source.nack).not.toHaveBeenCalled();
    }
  );

  test('non-final-save delayed tasks retain fixed fallback routing', async () => {
    const pending = run(task({c: 'sfcm'}));
    await flush();
    confirms.shift()(new Error('response failed'));
    await flush();
    expect(queue.channelDelayed.sendToQueue.mock.calls[0][2].expiration).toBe('2000');
    confirms.shift()(null);
    await pending;
    expect(ack).toHaveBeenCalledTimes(1);
    expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
  });

  test.each([true, false])('timeout forcesave routing requires matching current changes: %s', async current => {
    queue.addTask = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(docs.editorData, 'getForceSave').mockResolvedValue({time: 123, index: current ? 4 : 5});
    await run(task({forcesave: {type: common.c_oAscForceSaveTypes.Timeout, time: 123, index: 4}}));
    expect(queue.addTask).toHaveBeenCalledTimes(current ? 1 : 0);
    if (current) {
      expect(queue.addTask).toHaveBeenCalledWith(expect.any(common.TaskQueueData), constants.QUEUE_PRIORITY_VERY_LOW, expect.any(Number));
    }
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
    expect(queue.channelConvertResponse.sendToQueue).not.toHaveBeenCalled();
  });

  test('the process-local requeue bound expires after an idle hour', async () => {
    const data = task();
    for (let i = 0; i < 30; i++) {
      await failBoth(data);
    }
    await jest.advanceTimersByTimeAsync(3600001);
    await failBoth(data);
    expect(nack).toHaveBeenCalledTimes(31);
    expect(ack).not.toHaveBeenCalled();
    expect(canvas.abandonSfcRetry).not.toHaveBeenCalled();
  });

  test('from-changes tasks retain normal-priority converter routing', async () => {
    queue.addTask = jest.fn().mockResolvedValue(undefined);
    await run(task({}, {fromChanges: true}));
    expect(queue.addTask).toHaveBeenCalledWith(expect.any(common.TaskQueueData), constants.QUEUE_PRIORITY_NORMAL, undefined);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(queue.channelConvertResponse.sendToQueue).not.toHaveBeenCalled();
  });

  test('ordinary dead letters retain the simulated converter error response', async () => {
    jest.spyOn(canvas, 'receiveTask').mockResolvedValue(undefined);
    await run(task({c: 'conv', attempt: 0}));
    const [data] = canvas.receiveTask.mock.calls[0];
    expect(JSON.parse(data).cmd.status_info).toBe(constants.CONVERT_DEAD_LETTER);
    expect(ack).toHaveBeenCalledTimes(1);
  });
});
