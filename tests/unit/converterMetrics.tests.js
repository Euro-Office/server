/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, beforeAll, afterAll} = require('@jest/globals');
const cluster = require('cluster');
const path = require('path');
const metrics = require('../../Common/sources/metrics');

describe('converter cluster metrics', () => {
  let server;
  let worker;
  let url;

  beforeAll(async () => {
    server = metrics.startClusterMetricsServer(0);
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    cluster.setupPrimary({exec: path.join(__dirname, 'helpers/converterMetricsWorker.js')});
    // Jest sandboxes process.env, so the config environment from env-setup.js is passed on explicitly
    worker = cluster.fork({NODE_ENV: process.env.NODE_ENV, NODE_CONFIG_DIR: process.env.NODE_CONFIG_DIR});
    await new Promise((resolve, reject) => {
      worker.on('message', message => message.type === 'ready' && resolve());
      worker.on('exit', code => reject(new Error(`worker exited with ${code}`)));
    });
  }, 20000);

  afterAll(async () => {
    worker.kill();
    await new Promise(resolve => server.close(resolve));
  });

  test('serves primary and worker metrics labelled per worker', async () => {
    const response = await fetch(`${url}/metrics`);
    expect(response.status).toBe(200);
    const parsed = metrics.parsePrometheusText(await response.text());
    const series = name => parsed.find(m => m.name === name)?.values ?? [];

    const workers = series('process_cpu_seconds_total').map(v => v.labels.worker);
    expect(workers).toEqual(expect.arrayContaining(['primary', String(worker.id)]));
    expect(series('eo_cluster_process_start_time_seconds').map(v => v.labels.worker)).toEqual(expect.arrayContaining(['primary', String(worker.id)]));
    expect(series('eo_x2t_running')).toEqual([expect.objectContaining({labels: {worker: String(worker.id)}, value: 1})]);
    expect(series('eo_x2t_duration_seconds').find(v => v.metricName === 'eo_x2t_duration_seconds_count')).toMatchObject({
      labels: {tool: 'x2t', result: 'ok', worker: String(worker.id)},
      value: 1
    });
  });

  test('answers only /metrics', async () => {
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });

  test('listens on 127.0.0.1 only', () => {
    expect(server.address().address).toBe('127.0.0.1');
  });
});
