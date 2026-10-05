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
  let watchedFile;
  let changeListener;
  const unwatchFile = jest.spyOn(fsWatch, 'unwatchFile').mockImplementation(() => {});
  jest.spyOn(utils, 'watchWithFallback').mockImplementation(async (_ctx, _dir, file, listener) => {
    watchedFile = file;
    changeListener = listener;
    return {};
  });

  await runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  runtimeConfigManager.closeRuntimeConfigWatcher();

  expect(unwatchFile).toHaveBeenCalledWith(watchedFile, changeListener);
});

test('a stale initialization does not stop the active polling watcher', async () => {
  const pending = [];
  jest.spyOn(fsPromises, 'statfs').mockImplementation(() => new Promise(resolve => pending.push(() => resolve({type: 0x6969}))));
  const watchFile = jest.spyOn(fsWatch, 'watchFile');

  const older = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  const newer = runtimeConfigManager.initRuntimeConfigWatcher({logger: {info: jest.fn()}});
  pending[1]();
  await newer;
  const onStop = jest.fn();
  watchFile.mock.results[0].value.on('stop', onStop);

  pending[0]();
  await older;
  await new Promise(resolve => setImmediate(resolve));

  expect(onStop).not.toHaveBeenCalled();
});
