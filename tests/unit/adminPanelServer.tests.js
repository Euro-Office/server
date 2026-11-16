/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const {describe, test, expect, beforeAll, afterAll} = require('@jest/globals');
const {fork} = require('child_process');
const net = require('net');
const path = require('path');

const freePort = () =>
  new Promise(resolve => {
    const server = net.createServer().listen(0, () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });

describe('admin panel server routes', () => {
  let child;
  let url;

  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/admin/api/v1`;
    // Jest sandboxes process.env, so the config environment from env-setup.js is passed on explicitly
    child = fork(path.join(__dirname, '../../AdminPanel/server/sources/server.js'), {
      env: {NODE_ENV: process.env.NODE_ENV, NODE_CONFIG_DIR: process.env.NODE_CONFIG_DIR, NODE_CONFIG: JSON.stringify({adminPanel: {port}})},
      stdio: 'ignore'
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(`${url}/setup/required`);
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw new Error('admin panel did not start');
  }, 20000);

  afterAll(() => {
    child.kill();
  });

  test.each(['stat'])('/%s requires the admin session', async route => {
    expect((await fetch(`${url}/${route}`)).status).toBe(401);
  });
});
