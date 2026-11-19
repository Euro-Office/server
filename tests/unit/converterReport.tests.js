/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, afterAll, beforeEach} = require('@jest/globals');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Fake binaries: x2t crashes, except for the OOXML retry in FAKE_X2T=odf mode. docbuilder always crashes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converter-report-'));
const x2tPath = path.join(dir, 'x2t');
const docbuilderPath = path.join(dir, 'docbuilder');
fs.writeFileSync(
  x2tPath,
  `#!/bin/sh
echo "stdout with document text"
to=$(sed -n 's:.*<m_sFileTo>\\([^<]*\\)</m_sFileTo>.*:\\1:p' "$1")
case "$FAKE_X2T:$to" in
  odf:*.ooxml) echo ok > "$to"; exit 0 ;;
esac
kill -SEGV $$
`,
  {mode: 0o755}
);
fs.writeFileSync(docbuilderPath, '#!/bin/sh\nkill -SEGV $$\n', {mode: 0o755});

process.env.NODE_CONFIG = JSON.stringify({
  storage: {fs: {folderPath: path.join(dir, 'storage')}},
  FileConverter: {converter: {x2tPath, docbuilderPath, errorfiles: ''}}
});
process.env.SENTRY_DSN = 'http://key@127.0.0.1:9/1';

const Sentry = require('../../Common/node_modules/@sentry/node');
require('../../Common/sources/reporters').init('converter');
const constants = require('../../Common/sources/constants');
const commonDefines = require('../../Common/sources/commondefines');
const operationContext = require('../../Common/sources/operationContext');
const storage = require('../../Common/sources/storage/storage-base');
const converter = require('../../FileConverter/sources/converter');
const co = require('../../FileConverter/node_modules/co');

// production log level, so stdout and stderr still pass the console appender at warn
require('../../Common/sources/logger').configureLogger({categories: {default: {level: 'WARN'}}});

const events = [];
Sentry.getClient().on('beforeSendEvent', event => events.push(event));

async function executeTask(docId, cmdData, taskData = {}) {
  const ctx = new operationContext.Context();
  ctx.setDocId(docId);
  await storage.putObject(ctx, `${docId}/origin.docx`, Buffer.from('docx'), 4);
  if (cmdData.savekey) {
    await storage.putObject(ctx, `${docId}${cmdData.savekey}/changes0.json`, Buffer.from('[]'), 2);
  }
  const task = new commonDefines.TaskQueueData({
    ctx: {tenant: 'localhost', docId},
    cmd: {c: 'save', id: docId, format: 'docx', ...cmdData},
    visibilityTimeout: 60,
    ...taskData
  });
  const res = await co(converter.ExecuteTask(ctx, task));
  await Sentry.flush(2000);
  return res;
}

const tagsOf = event => Object.fromEntries(Object.entries(event.tags).filter(([key]) => key.startsWith('converter.')));

describe('converter failure reports', () => {
  beforeEach(() => {
    events.length = 0;
    delete process.env.FAKE_X2T;
  });

  afterAll(() => {
    delete process.env.NODE_CONFIG;
    delete process.env.SENTRY_DSN;
    fs.rmSync(dir, {recursive: true, force: true});
  });

  test('x2t crash: one event per run, no breadcrumbs', async () => {
    const res = await executeTask('crash', {outputformat: constants.AVS_OFFICESTUDIO_FILE_CANVAS_WORD}, {fromOrigin: true, toFile: 'Editor.bin'});
    expect(res.getCmd().getStatusInfo()).toBe(constants.CONVERT);
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('ExitCode (code=null;signal=SIGSEGV;error:-80)');
    expect(tagsOf(events[0])).toEqual({
      'converter.binary': 'x2t',
      'converter.signal': 'SIGSEGV',
      'converter.error': '-80',
      'converter.formatFrom': 'docx',
      'converter.formatTo': 'bin'
    });
    expect(events[0].fingerprint).toEqual([
      'ExitCode (code=%s;signal=%s;error:%d)',
      'binary:x2t',
      'exitCode:null',
      'signal:SIGSEGV',
      'error:-80',
      'spawnError:null'
    ]);
    expect(events[0].breadcrumbs ?? []).toEqual([]);
  });

  test('outgoing requests of other tasks do not become breadcrumbs', async () => {
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${server.address().port}/other-tenant/doc?id=1`, res => res.resume().on('end', resolve)).on('error', reject);
      });
    } finally {
      server.close();
    }
    await executeTask('http', {outputformat: constants.AVS_OFFICESTUDIO_FILE_CANVAS_WORD}, {fromOrigin: true, toFile: 'Editor.bin'});
    expect(events).toHaveLength(1);
    expect(events[0].breadcrumbs ?? []).toEqual([]);
  });

  test('missing x2t binary is reported as a spawn error', async () => {
    fs.renameSync(x2tPath, `${x2tPath}.off`);
    try {
      await executeTask('enoent', {outputformat: constants.AVS_OFFICESTUDIO_FILE_CANVAS_WORD}, {fromOrigin: true, toFile: 'Editor.bin'});
    } finally {
      fs.renameSync(`${x2tPath}.off`, x2tPath);
    }
    expect(events).toHaveLength(1);
    expect(events[0].tags['converter.spawnError']).toBe('ENOENT');
    expect(events[0].fingerprint).toContain('spawnError:ENOENT');
  });

  test('docbuilder crash is grouped apart from x2t', async () => {
    await executeTask('builder', {c: 'builder', builderParams: {}, outputformat: constants.AVS_OFFICESTUDIO_FILE_DOCUMENT_DOCX});
    expect(events).toHaveLength(1);
    expect(events[0].tags['converter.binary']).toBe('docbuilder');
    expect(events[0].fingerprint).toContain('binary:docbuilder');
  });

  test('ODT writer crash recovered by the OOXML retry is still reported', async () => {
    process.env.FAKE_X2T = 'odf';
    const res = await executeTask(
      'retry',
      {savekey: 'sk', outputformat: constants.AVS_OFFICESTUDIO_FILE_DOCUMENT_ODT},
      {fromOrigin: true, fromChanges: true, toFile: 'output.odt'}
    );
    expect(res.getCmd().getStatusInfo()).toBe(constants.NO_ERROR);
    expect(res.getCmd().getOutputPath()).toBe('output.ooxml');
    expect(events).toHaveLength(1);
    expect(tagsOf(events[0])).toMatchObject({'converter.formatTo': 'odt', 'converter.signal': 'SIGSEGV'});
    expect(events[0].tags['converter.retry']).toBeUndefined();
  });

  test('both attempts failing are reported with their own target format', async () => {
    const res = await executeTask(
      'retryfail',
      {savekey: 'sk', outputformat: constants.AVS_OFFICESTUDIO_FILE_DOCUMENT_ODT},
      {fromOrigin: true, fromChanges: true, toFile: 'output.odt'}
    );
    expect(res.getCmd().getStatusInfo()).toBe(constants.CONVERT);
    expect(events.map(e => [e.tags['converter.formatTo'], e.tags['converter.retry']])).toEqual([
      ['odt', undefined],
      ['ooxml', 'ooxml']
    ]);
  });
});

describe('converter x2t metrics', () => {
  const metrics = require('../../Common/sources/metrics');
  const workerMetrics = metrics.registerConverterWorker('1');
  converter.setWorkerMetrics(workerMetrics);
  const runs = async result =>
    (await workerMetrics.x2tDuration.get()).values.find(v => v.metricName === 'eo_x2t_duration_seconds_count' && v.labels.result === result)?.value ??
    0;

  test('records failed and successful x2t runs and returns to zero running', async () => {
    delete process.env.FAKE_X2T;
    await executeTask('metricsfail', {savekey: 'sk'}, {fromOrigin: true, fromChanges: true, toFile: 'output.docx'});
    expect(await runs('error')).toBeGreaterThanOrEqual(1);

    process.env.FAKE_X2T = 'odf';
    await executeTask(
      'metricsok',
      {savekey: 'sk', outputformat: constants.AVS_OFFICESTUDIO_FILE_DOCUMENT_ODT},
      {fromOrigin: true, fromChanges: true, toFile: 'output.odt'}
    );
    delete process.env.FAKE_X2T;
    expect(await runs('ok')).toBe(1);
    expect((await workerMetrics.x2tRunning.get()).values[0].value).toBe(0);
  });

  const steps = async () => {
    const values = (await workerMetrics.stepDuration.get()).values;
    const of = (step, suffix) =>
      values.find(v => v.metricName === `eo_conversion_step_duration_seconds_${suffix}` && v.labels.step === step)?.value ?? 0;
    return Object.fromEntries(
      ['queue_wait', 'download', 'post_process', 'total'].map(step => [step, {count: of(step, 'count'), sum: of(step, 'sum')}])
    );
  };

  test('records queue wait, download, post process and total per task', async () => {
    const before = await steps();
    await executeTask('steps', {savekey: 'sk'}, {fromOrigin: true, fromChanges: true, toFile: 'output.docx', queuedAt: Date.now() - 5000});
    const after = await steps();
    for (const step of ['queue_wait', 'download', 'post_process', 'total']) {
      expect(after[step].count - before[step].count).toBe(1);
    }
    expect(after.queue_wait.sum - before.queue_wait.sum).toBeGreaterThanOrEqual(5);
  });

  test('skips the queue wait of tasks queued without a timestamp', async () => {
    const before = await steps();
    await executeTask('nostamp', {savekey: 'sk'}, {fromOrigin: true, fromChanges: true, toFile: 'output.docx'});
    const after = await steps();
    expect(after.queue_wait.count).toBe(before.queue_wait.count);
    expect(after.total.count - before.total.count).toBe(1);
  });
});

describe('conversion task queue', () => {
  test('stamps tasks with the time they were queued', async () => {
    const TaskQueueRabbitMQ = require('../../Common/sources/taskqueueRabbitMQ');
    const queue = new TaskQueueRabbitMQ();
    const task = new commonDefines.TaskQueueData({ctx: {tenant: 'localhost', docId: 'q'}, cmd: {c: 'open', id: 'q'}});
    const start = Date.now();
    await queue.addTask(task, constants.QUEUE_PRIORITY_LOW);
    const queued = new commonDefines.TaskQueueData(JSON.parse(queue.addTaskStore[0].task.toString()));
    expect(queued.getQueuedAt()).toBeGreaterThanOrEqual(start);
    expect(queued.getQueuedAt()).toBeLessThanOrEqual(Date.now());
  });
});
