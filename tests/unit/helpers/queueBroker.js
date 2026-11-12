/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';
const {EventEmitter} = require('node:events');
const {jest} = require('@jest/globals');

function channel() {
  return Object.assign(new EventEmitter(), {
    ack: jest.fn(),
    nack: jest.fn(),
    bindQueue: jest.fn(),
    sendToQueue: jest.fn(),
    add_credit: jest.fn(),
    send: jest.fn()
  });
}

function rabbit(core) {
  const channels = [];
  const consumers = new Map();
  let disconnect;
  jest.spyOn(core, 'connetPromise').mockImplementation(async callback => {
    disconnect = callback;
    return {};
  });
  for (const method of ['createChannelPromise', 'createConfirmChannelPromise']) {
    jest.spyOn(core, method).mockImplementation(async () => {
      const result = channel();
      channels.push(result);
      return result;
    });
  }
  jest.spyOn(core, 'assertQueuePromise').mockImplementation(async (_channel, name) => name);
  jest.spyOn(core, 'assertExchangePromise').mockResolvedValue(undefined);
  jest.spyOn(core, 'consumePromise').mockImplementation(async (source, _name, callback) => {
    consumers.set(source, callback);
  });
  return {
    channels,
    disconnect: () => disconnect(),
    deliver: (source, data = '{}') => {
      const message = {content: Buffer.from(data)};
      consumers.get(source)(message);
      return message;
    }
  };
}
module.exports = {channel, rabbit};
