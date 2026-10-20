/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {afterEach, expect, jest, test} = require('@jest/globals');
const fsWatch = require('fs');
const fsPromises = require('fs/promises');
const operationContext = require('../../Common/sources/operationContext');
const runtimeConfigManager = require('../../Common/sources/runtimeConfigManager');
const utils = require('../../Common/sources/utils');

afterEach(() => {
  runtimeConfigManager.closeRuntimeConfigWatcher();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('closes a healthy native runtime config watcher', async () => {
  const nativeWatcher = {close: jest.fn(), on: jest.fn()};
  jest.spyOn(fsPromises, 'statfs').mockResolvedValue({type: 0xef53});
  const watch = jest.spyOn(fsWatch, 'watch').mockReturnValue(nativeWatcher);
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockReturnValue({});

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  expect(watch).toHaveBeenCalledTimes(1);
  expect(nativeWatcher.close).not.toHaveBeenCalled();

  runtimeConfigManager.closeRuntimeConfigWatcher();

  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
  expect(watchFile).not.toHaveBeenCalled();
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
  expect(watcher.close).not.toHaveBeenCalled();

  runtimeConfigManager.closeRuntimeConfigWatcher();
  expect(jest.getTimerCount()).toBe(0);
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
  expect(watcher.close).not.toHaveBeenCalled();
  resolveWatcher();

  await initialization;

  expect(watcher.close).toHaveBeenCalledTimes(1);

  runtimeConfigManager.closeRuntimeConfigWatcher();
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

test('closes a stale watcher that resolves while the newer initialization is pending', async () => {
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

  runtimeConfigManager.closeRuntimeConfigWatcher();
  expect(firstWatcher.close).toHaveBeenCalledTimes(1);
  expect(secondWatcher.close).toHaveBeenCalledTimes(1);
});

test('closeRuntimeConfigWatcher is idempotent', async () => {
  const watcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockResolvedValue(watcher);

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  expect(watcher.close).not.toHaveBeenCalled();

  runtimeConfigManager.closeRuntimeConfigWatcher();
  expect(watcher.close).toHaveBeenCalledTimes(1);

  runtimeConfigManager.closeRuntimeConfigWatcher();

  expect(watcher.close).toHaveBeenCalledTimes(1);
});

test('closes the previous watcher when initialization runs again', async () => {
  const firstWatcher = {close: jest.fn()};
  const secondWatcher = {close: jest.fn()};
  jest.spyOn(utils, 'watchWithFallback').mockResolvedValueOnce(firstWatcher).mockResolvedValueOnce(secondWatcher);

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  expect(firstWatcher.close).not.toHaveBeenCalled();

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});

  expect(firstWatcher.close).toHaveBeenCalledTimes(1);
  expect(secondWatcher.close).not.toHaveBeenCalled();

  runtimeConfigManager.closeRuntimeConfigWatcher();
  expect(firstWatcher.close).toHaveBeenCalledTimes(1);
  expect(secondWatcher.close).toHaveBeenCalledTimes(1);
});

test('a stale native initialization does not remove the active polling listener', async () => {
  const pending = [];
  let pollingListener;
  jest.useFakeTimers();
  const cleanRuntimeConfigCache = jest.spyOn(operationContext.global, 'cleanRuntimeConfigCache');
  jest.spyOn(fsPromises, 'statfs').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const unwatchFile = jest.spyOn(fsWatch, 'unwatchFile').mockImplementation(() => {});
  const watchFile = jest.spyOn(fsWatch, 'watchFile').mockImplementation((_file, _opts, listener) => {
    pollingListener = listener;
    return {};
  });
  const nativeWatcher = {
    close: jest.fn(),
    on: jest.fn()
  };
  const watch = jest.spyOn(fsWatch, 'watch').mockReturnValue(nativeWatcher);

  const older = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  const newer = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  pending[1]({type: 0x6969});
  await newer;

  pending[0]({type: 0xef53});
  await older;

  expect(unwatchFile).not.toHaveBeenCalled();
  expect(watch).toHaveBeenCalledTimes(1);
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
  expect(watchFile).toHaveBeenCalledTimes(1);

  // Deliver a polling event after the stale native watcher has been closed.
  pollingListener({isFile: true, mtime: 2}, {mtime: 1});
  jest.runOnlyPendingTimers();

  expect(cleanRuntimeConfigCache).toHaveBeenCalledTimes(1);

  runtimeConfigManager.closeRuntimeConfigWatcher();
  expect(unwatchFile).toHaveBeenCalledTimes(1);
  expect(unwatchFile).toHaveBeenCalledWith(watchFile.mock.calls[0][0], pollingListener);
  expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
});
