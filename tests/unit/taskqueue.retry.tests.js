/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('node:assert/strict');
const {describe, jest, test} = require('@jest/globals');

function createQueue(type) {
  let Queue;
  jest.isolateModules(() => {
    jest.doMock('../../Common/node_modules/config', () => {
      const config = jest.requireActual('../../Common/node_modules/config');
      return {...config, util: config.util, get: key => (key === 'queue.type' ? type : config.get(key))};
    });
    Queue = require('../../Common/sources/taskqueueRabbitMQ');
  });
  jest.dontMock('../../Common/node_modules/config');
  return new Queue();
}

describe.each(['rabbitmq', 'activemq'])('%s delayed callback retries', type => {
  test('rejects when disconnected instead of reporting an in-memory retry as persisted', async () => {
    const queue = createQueue(type);
    await assert.rejects(queue.addDelayed({cmd: {c: 'sfc'}}, 1000), /Delayed queue is unavailable/);
  });

  test.each([false, true])('settles only after broker confirmation (rejected: %s)', async rejected => {
    const queue = createQueue(type);
    const error = new Error('broker rejected retry');
    let confirm;
    let sent;
    if (type === 'rabbitmq') {
      queue.channelDelayed = {
        sendToQueue(_name, content, options, callback) {
          sent = {content, options};
          confirm = () => callback(rejected ? error : null);
        }
      };
    } else {
      queue.channelDelayed = {
        send(message) {
          sent = {content: message.body, options: message};
          confirm = () => queue.channelDelayedData[7](rejected ? error : null);
          return {id: 7};
        }
      };
    }

    let settled = false;
    const pending = queue.addDelayed({cmd: {c: 'sfc'}}, 1000);
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(JSON.parse(sent.content.toString()), {cmd: {c: 'sfc'}});
    if (type === 'rabbitmq') {
      assert.equal(sent.options.persistent, true);
      assert.equal(sent.options.expiration, '1000');
    } else {
      assert.equal(sent.options.durable, true);
      assert.equal(sent.options.ttl, 1000);
    }
    confirm();
    if (rejected) {
      await assert.rejects(pending, actual => actual === error);
    } else {
      await pending;
    }
  });
});
