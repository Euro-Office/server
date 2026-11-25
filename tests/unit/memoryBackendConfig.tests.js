'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {describe, test} = require('@jest/globals');

const repo = path.resolve(__dirname, '../..');

describe('in-memory editor data with Redis-only configuration', () => {
  test('DocService loads without the Redis backend checks (prefix braces, Redis TTL rules)', () => {
    const script = `
      require('${repo}/Common/sources/operationContext');
      require('${repo}/DocService/sources/DocsCoServer');
      const loaded = Object.keys(require.cache).filter(k => k.includes('editorDataRedis' + require('path').sep));
      process.stdout.write(JSON.stringify(loaded.map(k => require('path').basename(k))));
      process.exit(0);
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(repo, 'DocService'),
      env: {
        ...process.env,
        NODE_CONFIG_DIR: path.join(repo, 'Common/config'),
        NODE_ENV: process.env.NODE_ENV || 'development-linux',
        NODE_CONFIG: JSON.stringify({
          services: {CoAuthoring: {server: {editorDataStorage: 'editorDataMemory'}, redis: {prefix: '{}x'}, expire: {saved: 0, lockDoc: '0'}}}
        })
      },
      encoding: 'utf8',
      timeout: 60000
    });
    assert.deepEqual(JSON.parse(output.trim().split('\n').pop()), ['expiredQueueLease.js']);
  }, 70000);
});
