/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, jest, beforeAll, afterAll} = require('@jest/globals');
const express = require('../../AdminPanel/server/node_modules/express');
const jwt = require('../../Common/node_modules/jsonwebtoken');
const metrics = require('../../Common/sources/metrics');
const statsRouter = require('../../AdminPanel/server/sources/routes/stats/router');
const {createHistory, histogramQuantile} = require('../../AdminPanel/server/sources/routes/stats/history');
const adminPanelJwtSecret = require('../../AdminPanel/server/sources/jwtSecret');
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

describe('histogramQuantile', () => {
  test('interpolates inside the bucket that holds the rank', () => {
    expect(
      histogramQuantile(
        [
          {le: 1, count: 0},
          {le: 2, count: 10},
          {le: Infinity, count: 10}
        ],
        0.5
      )
    ).toBeCloseTo(1.5);
  });

  test('returns the highest finite bound when the rank falls into +Inf', () => {
    expect(
      histogramQuantile(
        [
          {le: 1, count: 1},
          {le: Infinity, count: 10}
        ],
        0.95
      )
    ).toBe(1);
  });

  test('returns null without observations', () => {
    expect(histogramQuantile([{le: Infinity, count: 0}], 0.5)).toBeNull();
  });
});

describe('docservice metrics through the dashboard summary', () => {
  let queueLength;
  const docServiceMetrics = async () => metrics.parsePrometheusText(await metrics.register.metrics());

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

  test('summarizes sessions, conversions, host and processes from the Prometheus text', async () => {
    queueLength = () => Promise.resolve(7);
    const summary = statsRouter.summarize({docService: await docServiceMetrics(), adminPanel: []});

    expect(summary.docServiceAvailable).toBe(true);
    expect(summary.server).toMatchObject({buildVersion: expect.any(String), database: {type: expect.any(String)}});
    expect(summary.server.database).not.toHaveProperty('pass');
    expect(summary.sessions).toEqual({connections: {edit: 2, view: 1, liveview: 0}, users: {edit: 2, view: 1, liveview: 0}, documents: 2});
    expect(summary.conversions).toEqual({ok: 2, error: 1, queue: 7});
    expect(Object.keys(summary.host.load)).toEqual(['1m', '5m', '15m']);
    expect(summary.host.memory.total).toBeGreaterThan(summary.host.memory.used);
    expect(summary.host.disks).toEqual([{path: __dirname, total: expect.any(Number), available: expect.any(Number)}]);
    expect(summary.processes.map(p => p.name)).toEqual(['docservice', 'adminpanel']);
    expect(summary.processes[0].cpuSeconds).toBeGreaterThan(0);
  });

  test('leaves the queue empty when the queue cannot be read', async () => {
    queueLength = () => Promise.reject(new Error('channel closed'));
    const summary = statsRouter.summarize({docService: await docServiceMetrics(), adminPanel: []});
    expect(summary.conversions.queue).toBeNull();
  });

  test('reports only the admin panel when docservice is unreachable', () => {
    const summary = statsRouter.summarize({docService: null, adminPanel: []});
    expect(summary).toMatchObject({docServiceAvailable: false, converterAvailable: false, x2t: null});
    expect(summary.processes.map(p => p.name)).toEqual(['adminpanel']);
    expect(summary).not.toHaveProperty('sessions');
  });
});

describe('admin panel stats routes', () => {
  let server;
  let url;
  const cookie = `accessToken=${jwt.sign({tenant: 'localhost', isAdmin: true}, adminPanelJwtSecret)}`;

  beforeAll(done => {
    const app = express();
    app.use('/stats', statsRouter);
    server = app.listen(0, () => {
      url = `http://127.0.0.1:${server.address().port}/stats`;
      done();
    });
  });
  afterAll(done => {
    server.close(done);
  });

  test.each(['resources', 'history'])('/%s rejects requests without the admin session cookie', async route => {
    expect((await fetch(`${url}/${route}`)).status).toBe(401);
  });

  test('/resources samples on first use and returns the summary', async () => {
    const response = await fetch(`${url}/resources`, {headers: {Cookie: cookie}});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.collectedAt).toEqual(expect.any(Number));
    const adminPanel = body.processes.find(p => p.name === 'adminpanel');
    expect(adminPanel.cpuSeconds).toBeGreaterThan(0);
    expect(adminPanel.residentMemoryBytes ?? adminPanel.heapUsedBytes).toBeGreaterThan(0);
  });

  test('/history returns the samples after a time', async () => {
    const body = await (await fetch(`${url}/history?since=0`, {headers: {Cookie: cookie}})).json();
    expect(body.intervalMs).toBe(30000);
    expect(body.samples.length).toBeGreaterThan(0);
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

describe('converter summary', () => {
  const converterText = [
    '# TYPE process_cpu_seconds_total counter',
    'process_cpu_seconds_total{worker="primary"} 1',
    'process_cpu_seconds_total{worker="1"} 3',
    'process_cpu_seconds_total{worker="2"} 4',
    '# TYPE process_resident_memory_bytes gauge',
    'process_resident_memory_bytes{worker="primary"} 100',
    'process_resident_memory_bytes{worker="1"} 200',
    'process_resident_memory_bytes{worker="2"} 300',
    '# TYPE eo_x2t_running gauge',
    'eo_x2t_running{worker="1"} 1',
    'eo_x2t_running{worker="2"} 1',
    '# TYPE eo_x2t_duration_seconds histogram',
    'eo_x2t_duration_seconds_bucket{le="1",tool="x2t",result="ok",worker="1"} 2',
    'eo_x2t_duration_seconds_bucket{le="+Inf",tool="x2t",result="ok",worker="1"} 2',
    'eo_x2t_duration_seconds_count{tool="x2t",result="ok",worker="1"} 2',
    'eo_x2t_duration_seconds_bucket{le="1",tool="x2t",result="error",worker="2"} 0',
    'eo_x2t_duration_seconds_bucket{le="+Inf",tool="x2t",result="error",worker="2"} 1',
    'eo_x2t_duration_seconds_count{tool="x2t",result="error",worker="2"} 1',
    'eo_x2t_duration_seconds_bucket{le="1",tool="x2t",result="timeout",worker="2"} 0',
    'eo_x2t_duration_seconds_bucket{le="+Inf",tool="x2t",result="timeout",worker="2"} 1',
    'eo_x2t_duration_seconds_count{tool="x2t",result="timeout",worker="2"} 1'
  ].join('\n');

  test('passes the slow tasks and their threshold on', () => {
    const slowTasks = [{fileName: 'a.pptx', total: 12000}];
    const summary = statsRouter.summarize({docService: null, adminPanel: [], slowTasks});
    expect(summary.slowTasks).toBe(slowTasks);
    expect(summary.server.slowTaskThreshold).toBe('10s');
  });

  test('lists the primary and workers and sums x2t over workers', () => {
    const summary = statsRouter.summarize({docService: null, adminPanel: [], converter: metrics.parsePrometheusText(converterText)});
    expect(summary.converterAvailable).toBe(true);
    expect(summary.processes.map(p => [p.name, p.cpuSeconds, p.residentMemoryBytes])).toEqual([
      ['adminpanel', null, null],
      ['converter', 1, 100],
      ['converter worker 1', 3, 200],
      ['converter worker 2', 4, 300]
    ]);
    expect(summary.x2t).toMatchObject({running: 2, failed: 2, durationSeconds: {count: 4}});
    expect(summary.x2t.durationSeconds.p50).toBeCloseTo(1);
  });
});

describe('dashboard history', () => {
  const proc = (name, cpuSeconds, residentMemoryBytes = 100) => ({name, cpuSeconds, residentMemoryBytes, startTimeSeconds: 1});
  const summary = (t, {cpu = 0, ok = 0, workerCpu = 0, fast = 0, slow = 0} = {}) => ({
    collectedAt: t,
    sessions: {connections: {edit: 2, view: 1, liveview: 0}},
    conversions: {ok, error: 1},
    x2t: {
      durationSeconds: {
        buckets: [
          {le: 1, count: fast},
          {le: 2, count: fast + slow},
          {le: Infinity, count: fast + slow}
        ]
      }
    },
    host: {memory: {used: 600}},
    processes: [proc('docservice', cpu, 300), proc('adminpanel', 0), proc('converter', 0, 50), proc('converter worker 1', workerCpu, 70)]
  });

  test('first sample has values but no rates', () => {
    const history = createHistory();
    history.add(summary(1000));
    expect(history.since(0)[0]).toMatchObject({t: 1000, conversionsOk: null, x2tP50: null, memory: {host: 600, docservice: 300, converter: 120}});
    expect(history.since(0)[0].cpu).toEqual({docservice: null, converter: null, adminpanel: null});
    expect(history.latest().processes[0].cpu).toBeNull();
  });

  test('rates and x2t quantiles cover the interval between two samples', () => {
    const history = createHistory();
    history.add(summary(1000, {cpu: 1, ok: 10, fast: 5}));
    history.add(summary(31000, {cpu: 4, ok: 25, workerCpu: 3, fast: 5, slow: 4}));
    const sample = history.since(0)[1];
    expect(sample.cpu.docservice).toBeCloseTo(0.1);
    expect(sample.cpu.converter).toBeCloseTo(0.1);
    expect(sample.conversionsOk).toBeCloseTo(30);
    expect(sample.conversionsFailed).toBe(0);
    expect(sample.x2tP50).toBeGreaterThan(1);
    expect(sample.x2tP50).toBeLessThanOrEqual(2);
    expect(history.latest().processes[0].cpu).toBeCloseTo(0.1);
  });

  test('a counter reset from a restart gives no rate instead of a negative one', () => {
    const history = createHistory();
    history.add(summary(1000, {ok: 50}));
    history.add(summary(31000, {ok: 2}));
    expect(history.since(0)[1].conversionsOk).toBeNull();
  });

  test('keeps only the newest samples and returns the ones after a time', () => {
    const history = createHistory(3);
    for (let t = 1; t <= 5; t++) {
      history.add(summary(t * 1000));
    }
    expect(history.since(0).map(s => s.t)).toEqual([3000, 4000, 5000]);
    expect(history.since(4000).map(s => s.t)).toEqual([5000]);
  });
});
