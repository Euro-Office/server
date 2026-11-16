/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, jest, beforeAll} = require('@jest/globals');
const metrics = require('../../Common/sources/metrics');
const TaskQueueRabbitMQ = require('../../Common/sources/taskqueueRabbitMQ');

const editor = (docId, userId) => ({docId, user: {idOriginal: userId}});
const viewer = (docId, userId) => ({docId, user: {idOriginal: userId, view: true}});
const liveViewer = (docId, userId) => ({docId, coEditingMode: 'fast', user: {idOriginal: userId, view: true}});

describe('countConnections', () => {
  test('counts connections and unique users per mode and open documents', () => {
    const result = metrics.countConnections([
      editor('doc1', 'alice'),
      editor('doc1', 'alice'),
      editor('doc2', 'bob'),
      {docId: 'doc2', user: {}},
      viewer('doc2', 'carol'),
      liveViewer('doc3', 'dave'),
      {docId: 'doc3', isCloseCoAuthoring: true, user: {idOriginal: 'erin'}}
    ]);
    expect(result).toEqual({
      modes: {
        edit: {connections: 4, users: 2},
        view: {connections: 2, users: 2},
        liveview: {connections: 1, users: 1}
      },
      documents: 3
    });
  });
});

describe('docservice metrics', () => {
  let queueLength;

  beforeAll(() => {
    const connections = [editor('doc1', 'alice'), editor('doc1', 'bob'), viewer('doc2', 'carol')];
    metrics.registerDocServiceMetrics(
      () => connections,
      () => queueLength()
    );
    metrics.registerHostMetrics([__dirname, '/path/that/does/not/exist']);
    metrics.conversionsCompleted.inc({result: 'ok'}, 2);
    metrics.conversionsCompleted.inc({result: 'error'});
  });

  test('serves sessions, queue, conversions and host in the Prometheus text format', async () => {
    queueLength = () => Promise.resolve(7);
    const text = await metrics.register.metrics();
    expect(text).toContain('eo_connections{mode="edit"} 2');
    expect(text).toContain('eo_users{mode="view"} 1');
    expect(text).toContain('eo_documents_open 2');
    expect(text).toContain('eo_conversion_queue_tasks{queue="convert"} 7');
    expect(text).toContain('eo_conversion_tasks_completed_total{result="error"} 1');
    expect(text).toMatch(/eo_host_load_average\{period="1m"\} \d/);
    expect(text).toContain(`eo_host_disk_bytes{path="${__dirname}",type="total"}`);
    expect(text).not.toContain('/path/that/does/not/exist');
    expect(text).toContain('process_cpu_seconds_total');
  });

  test('leaves the queue out when the queue cannot be read', async () => {
    queueLength = () => Promise.reject(new Error('channel closed'));
    expect(await metrics.register.metrics()).not.toContain('eo_conversion_queue_tasks{');
  });
});

describe('getConvertTaskQueueLength', () => {
  const fakeConnection = checkQueue => {
    const channel = {checkQueue, on: jest.fn(), close: jest.fn()};
    return {channel, connection: {createChannel: cb => cb(null, channel)}};
  };

  test('reads the message count on its own channel and closes it', async () => {
    const {channel, connection} = fakeConnection((name, cb) => cb(null, {messageCount: 5}));
    const queue = new TaskQueueRabbitMQ();
    queue.connection = connection;
    queue.channelConvertTask = {checkQueue: jest.fn()};
    await expect(queue.getConvertTaskQueueLength()).resolves.toBe(5);
    expect(queue.channelConvertTask.checkQueue).not.toHaveBeenCalled();
    expect(channel.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(channel.close).toHaveBeenCalled();
  });

  test('rejects and still closes the channel when the check fails', async () => {
    const {channel, connection} = fakeConnection((name, cb) => cb(new Error('NOT_FOUND')));
    const queue = new TaskQueueRabbitMQ();
    queue.connection = connection;
    await expect(queue.getConvertTaskQueueLength()).rejects.toThrow('NOT_FOUND');
    expect(channel.close).toHaveBeenCalled();
  });

  test('returns null before the queue is connected', async () => {
    await expect(new TaskQueueRabbitMQ().getConvertTaskQueueLength()).resolves.toBeNull();
  });
});
