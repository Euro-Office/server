/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {afterEach, expect, jest, test} = require('@jest/globals');
const fsWatch = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const utils = require('../../Common/sources/utils');

const ctx = {logger: {info: jest.fn()}};

afterEach(() => {
  jest.restoreAllMocks();
});

test('closes a polling fallback and removes only its listener', async () => {
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0x6969});
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockReturnValue({});
  const unwatchFile = jest.spyOn(fsWatch, 'unwatchFile').mockImplementation(() => {});
  const listener = jest.fn();

  const watcher = await utils.watchWithFallback(ctx, '/config', '/config/runtime.json', listener);
  watcher.close();

  expect(watchFile).toHaveBeenCalledWith('/config/runtime.json', {}, listener);
  expect(unwatchFile).toHaveBeenCalledWith('/config/runtime.json', listener);
});

test('removes polling fallback when a native watcher errors', async () => {
  let onError;
  const nativeWatcher = {close: jest.fn(), on: jest.fn((_event, callback) => (onError = callback))};
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0xef53});
  const watch = jest.spyOn(fsWatch, 'watch').mockReturnValue(nativeWatcher);
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockReturnValue({});
  const unwatchFile = jest.spyOn(fsWatch, 'unwatchFile').mockImplementation(() => {});
  const listener = jest.fn();

  const watcher = await utils.watchWithFallback(ctx, '/config', '/config/runtime.json', listener);
  onError(new Error('native watcher failed'));
  watcher.close();

  expect(watch).toHaveBeenCalledWith('/config', {}, listener);
  expect(watchFile).toHaveBeenCalledWith('/config/runtime.json', {}, listener);
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
  expect(unwatchFile).toHaveBeenCalledWith('/config/runtime.json', listener);
});

test('polling fallback detects a subsequent file edit', async () => {
  let onError;
  const nativeWatcher = {close: jest.fn(), on: jest.fn((_event, callback) => (onError = callback))};
  const tempDir = fsWatch.mkdtempSync(path.join(os.tmpdir(), 'watch-with-fallback-'));
  const filePath = path.join(tempDir, 'runtime.json');
  fsWatch.writeFileSync(filePath, '{}');

  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0xef53});
  jest.spyOn(fsWatch, 'watch').mockReturnValue(nativeWatcher);
  const listener = jest.fn();
  let watcher;

  try {
    watcher = await utils.watchWithFallback({logger: {info: jest.fn()}}, tempDir, filePath, listener, {interval: 10});
    onError(new Error('native watcher failed'));

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error('polling watcher did not detect the file edit'));
      }, 1000);
      const check = setInterval(() => {
        if (listener.mock.calls.length > 0) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
          return;
        }

        fsWatch.appendFileSync(filePath, ' ');
      }, 20);
    });

    expect(listener).toHaveBeenCalled();
  } finally {
    watcher?.close();
    fsWatch.rmSync(tempDir, {recursive: true, force: true});
  }
});

test('does not start polling if a native watcher errors after close', async () => {
  let onError;
  const nativeWatcher = {close: jest.fn(), on: jest.fn((_event, callback) => (onError = callback))};
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0xef53});
  jest.spyOn(fsWatch, 'watch').mockReturnValue(nativeWatcher);
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockReturnValue({});
  const listener = jest.fn();

  const watcher = await utils.watchWithFallback(ctx, '/config', '/config/runtime.json', listener);
  watcher.close();
  onError(new Error('late native watcher failure'));

  expect(watchFile).not.toHaveBeenCalled();
});
