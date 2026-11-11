/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, afterAll, beforeEach} = require('@jest/globals');
const fs = require('fs');
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
