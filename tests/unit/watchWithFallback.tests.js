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

test('unregisters its polling listener when closed', async () => {
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0x6969});
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockReturnValue({});
  const unwatchFile = jest.spyOn(fsWatch, 'unwatchFile').mockImplementation(() => {});
  const listener = jest.fn();

  const watcher = await utils.watchWithFallback(ctx, '/config', '/config/runtime.json', listener);
  expect(watchFile).toHaveBeenCalledTimes(1);
  expect(watchFile).toHaveBeenCalledWith('/config/runtime.json', {}, listener);
  expect(unwatchFile).not.toHaveBeenCalled();

  watcher.close();

  expect(unwatchFile).toHaveBeenCalledTimes(1);
  expect(unwatchFile).toHaveBeenCalledWith('/config/runtime.json', listener);
});

test('removes polling fallback on close after a native watcher error', async () => {
  let onError;
  const nativeWatcher = {close: jest.fn(), on: jest.fn((_event, callback) => (onError = callback))};
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0xef53});
  const watch = jest.spyOn(fsWatch, 'watch').mockReturnValue(nativeWatcher);
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockReturnValue({});
  const unwatchFile = jest.spyOn(fsWatch, 'unwatchFile').mockImplementation(() => {});
  const listener = jest.fn();

  const watcher = await utils.watchWithFallback(ctx, '/config', '/config/runtime.json', listener);
  expect(watch).toHaveBeenCalledWith('/config', {}, listener);
  expect(nativeWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
  expect(nativeWatcher.close).not.toHaveBeenCalled();
  expect(watchFile).not.toHaveBeenCalled();

  onError(new Error('native watcher failed'));
  expect(watchFile).toHaveBeenCalledTimes(1);
  expect(watchFile).toHaveBeenCalledWith('/config/runtime.json', {}, listener);
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
  expect(unwatchFile).not.toHaveBeenCalled();

  watcher.close();

  expect(unwatchFile).toHaveBeenCalledTimes(1);
  expect(unwatchFile).toHaveBeenCalledWith('/config/runtime.json', listener);
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
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
    expect(nativeWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
    onError(new Error('native watcher failed'));
    expect(listener).not.toHaveBeenCalled();

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
    const [current, previous] = listener.mock.calls[0];
    expect(current.size).toBeGreaterThan(previous.size);
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
  expect(nativeWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
  expect(nativeWatcher.close).not.toHaveBeenCalled();
  watcher.close();
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
  onError(new Error('late native watcher failure'));

  expect(watchFile).not.toHaveBeenCalled();
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
});
