/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {afterEach, expect, jest, test} = require('@jest/globals');
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
});
