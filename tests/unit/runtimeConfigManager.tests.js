/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {afterEach, expect, jest, test} = require('@jest/globals');
const fsWatch = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const operationContext = require('../../Common/sources/operationContext');
const runtimeConfigManager = require('../../Common/sources/runtimeConfigManager');
const utils = require('../../Common/sources/utils');

afterEach(() => {
  runtimeConfigManager.closeRuntimeConfigWatcher();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('closes the runtime watcher and clears its pending reload timer', async () => {
  jest.useFakeTimers();
  let changeListener;
  const watcher = {close: jest.fn()};
  const watchWithFallback = jest.spyOn(utils, 'watchWithFallback').mockImplementation(async (_ctx, _dir, _file, listener) => {
    changeListener = listener;
    return watcher;
  });
  const cleanRuntimeConfigCache = jest.spyOn(operationContext.global, 'cleanRuntimeConfigCache');

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  changeListener('change', 'runtime.json');
  expect(jest.getTimerCount()).toBe(1);

  runtimeConfigManager.closeRuntimeConfigWatcher();
  jest.runOnlyPendingTimers();

  expect(watchWithFallback).toHaveBeenCalledTimes(1);
  expect(watcher.close).toHaveBeenCalledTimes(1);
  expect(cleanRuntimeConfigCache).not.toHaveBeenCalled();

  changeListener('change', 'runtime.json');
  expect(jest.getTimerCount()).toBe(0);
});

test('closes a watcher when shutdown races with watcher initialization', async () => {
  let resolveWatcher;
  const watcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockImplementation(
    () =>
      new Promise(resolve => {
        resolveWatcher = () => resolve(watcher);
      })
  );

  const initialization = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  runtimeConfigManager.closeRuntimeConfigWatcher();
  resolveWatcher();

  await initialization;

  expect(watcher.close).toHaveBeenCalledTimes(1);
});

test('does not let an older initialization replace a newer watcher', async () => {
  let resolveFirst;
  let resolveSecond;
  const firstWatcher = {close: jest.fn()};
  const secondWatcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveFirst = () => resolve(firstWatcher);
      })
  );
  jest.spyOn(utils, 'watchWithFallback').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveSecond = () => resolve(secondWatcher);
      })
  );

  const firstInitialization = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  const secondInitialization = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  resolveFirst();
  await firstInitialization;
  expect(firstWatcher.close).toHaveBeenCalledTimes(1);

  resolveSecond();
  await secondInitialization;
  expect(secondWatcher.close).not.toHaveBeenCalled();
});

test('closeRuntimeConfigWatcher is idempotent', async () => {
  const watcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockResolvedValue(watcher);

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  runtimeConfigManager.closeRuntimeConfigWatcher();
  runtimeConfigManager.closeRuntimeConfigWatcher();

  expect(watcher.close).toHaveBeenCalledTimes(1);
});

test('closes the previous watcher when initialization runs again', async () => {
  const firstWatcher = {close: jest.fn()};
  const secondWatcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockResolvedValueOnce(firstWatcher).mockResolvedValueOnce(secondWatcher);

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});

  expect(firstWatcher.close).toHaveBeenCalledTimes(1);
  expect(secondWatcher.close).not.toHaveBeenCalled();
});

test('removes the file callback when closing a polling watcher', async () => {
  const watcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockResolvedValue(watcher);

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  runtimeConfigManager.closeRuntimeConfigWatcher();

  expect(watcher.close).toHaveBeenCalledTimes(1);
});

test('a stale native initialization does not remove the active polling listener', async () => {
  const pending = [];
  const runtimeFile = path.resolve(__dirname, '../../runtime.json');
  const runtimeFileExists = fsWatch.existsSync(runtimeFile);
  const originalRuntimeFile = runtimeFileExists ? fsWatch.readFileSync(runtimeFile) : null;
  const originalWatchFile = fsWatch.watchFile;
  const cleanRuntimeConfigCache = jest.spyOn(operationContext.global, 'cleanRuntimeConfigCache');
  jest.spyOn(fsPromises, 'statfs').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  jest.spyOn(fsWatch, 'watchFile').mockImplementation((file, _opts, listener) => {
    return originalWatchFile(file, {interval: 10}, listener);
  });

  try {
    fsWatch.writeFileSync(runtimeFile, '{}');
    const older = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
    const newer = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
    pending[1]({type: 0x6969});
    await newer;

    pending[0]({type: 0xEF53});
    await older;

    fsWatch.writeFileSync(runtimeFile, '{"changed":true}');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('active polling watcher did not reload the edited file')), 1000);
      const check = setInterval(() => {
        if (cleanRuntimeConfigCache.mock.calls.length > 0) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(cleanRuntimeConfigCache).toHaveBeenCalledTimes(1);
  } finally {
    runtimeConfigManager.closeRuntimeConfigWatcher();
    if (runtimeFileExists) {
      fsWatch.writeFileSync(runtimeFile, originalRuntimeFile);
    } else {
      fsWatch.rmSync(runtimeFile, {force: true});
    }
  }
});
