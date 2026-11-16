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

describe('summarizeDocuments', () => {
  const at = (docId, userId, connect, lastAction, extra = {}) => ({
    docId,
    fileName: `${docId}.docx`,
    sessionTimeConnect: connect,
    sessionTimeLastAction: lastAction,
    user: {idOriginal: userId},
    ...extra
  });

  test('groups connections per document with users, modes and timings, without the document key', () => {
    const result = metrics.summarizeDocuments(
      [
        at('a', 'u1', 1000, 5000),
        at('a', 'u1', 2000, 3000),
        at('a', 'u2', 1500, 4000, {user: {idOriginal: 'u2', view: true}}),
        at('b', 'u3', 500, 600)
      ],
      10
    );
    expect(result.total).toBe(2);
    expect(result.documents).toEqual([
      {fileName: 'a.docx', users: 2, connections: {edit: 2, view: 1, liveview: 0}, openedAt: 1000, lastActionAt: 5000},
      {fileName: 'b.docx', users: 1, connections: {edit: 1, view: 0, liveview: 0}, openedAt: 500, lastActionAt: 600}
    ]);
  });

  test('limits the list to the largest documents but counts all in totals and distribution', () => {
    const connections = [];
    for (let doc = 0; doc < 30; doc++) {
      const users = doc === 0 ? 25 : doc < 5 ? 7 : doc < 10 ? 3 : 1;
      for (let user = 0; user < users; user++) {
        connections.push(at(`doc${doc}`, `user${user}`, 0, 0));
      }
    }
    const result = metrics.summarizeDocuments(connections, 5);
    expect(result.total).toBe(30);
    expect(result.distribution).toEqual({1: 20, '2-5': 5, '6-20': 4, '>20': 1});
    expect(result.documents.map(d => d.users)).toEqual([25, 7, 7, 7, 7]);
  });
});

describe('parsePrometheusText', () => {
  test('reads types, labels with escapes, infinite values and histogram series', () => {
    const parsed = metrics.parsePrometheusText(
      [
        '# HELP eo_x2t_running help',
        '# TYPE eo_x2t_running gauge',
        'eo_x2t_running{worker="1"} 1',
        '# TYPE eo_x2t_duration_seconds histogram',
        'eo_x2t_duration_seconds_bucket{le="1",worker="1"} 2',
        '# TYPE odd gauge',
        'odd{path="C:\\\\tmp \\"x\\""} +Inf',
        ''
      ].join('\n')
    );
    expect(parsed.map(m => m.name)).toEqual(['eo_x2t_running', 'eo_x2t_duration_seconds', 'odd']);
    expect(parsed[0].values).toEqual([{labels: {worker: '1'}, value: 1, metricName: 'eo_x2t_running'}]);
    expect(parsed[1].values[0]).toMatchObject({metricName: 'eo_x2t_duration_seconds_bucket', labels: {le: '1', worker: '1'}});
    expect(parsed[2].values[0]).toEqual({labels: {path: 'C:\\tmp "x"'}, value: Infinity, metricName: 'odd'});
  });
});
