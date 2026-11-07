/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const {afterEach, describe, expect, jest, test} = require('@jest/globals');

function startMaster(options = {}) {
  const settings = {'FileConverter.converter.maxprocesscount': options.multiplier ?? 1};
  if (Object.hasOwn(options, 'workercount')) {
    settings['FileConverter.converter.workercount'] = options.workercount;
  }
  const config = {
    has: key => settings[key] !== undefined,
    get: key => {
      if (settings[key] === undefined) {
        throw new Error(`Missing configuration: ${key}`);
      }
      return settings[key];
    }
  };
  const os = {cpus: jest.fn(() => Array(options.cpus ?? 8).fill({}))};
  if (!options.withoutAvailableParallelism) {
    os.availableParallelism = jest.fn(() => options.parallelism ?? 4);
  }
  const cluster = {isMaster: true, workers: {}, on: jest.fn()};
  let nextPid = 100;
  cluster.fork = jest.fn(() => {
    const worker = {process: {pid: nextPid++}};
    cluster.workers[worker.process.pid] = worker;
    return worker;
  });
  const logger = {warn: jest.fn(), error: jest.fn()};

  // Isolate startup side effects while exercising the real master entry point.
  jest.spyOn(process, 'on').mockReturnValue(process);
  jest.isolateModules(() => {
    jest.doMock('cluster', () => cluster);
    jest.doMock('os', () => os);
    jest.doMock('../../Common/sources/reporters', () => ({init: jest.fn()}));
    jest.doMock('../../Common/sources/moduleReloader', () => ({
      requireConfigWithRuntime: () => config,
      finalizeConfigWithRuntime: jest.fn()
    }));
    jest.doMock('../../Common/sources/logger', () => ({shutdown: jest.fn()}));
    jest.doMock('../../Common/sources/operationContext', () => ({global: {logger}}));
    jest.doMock('../../Common/sources/runtimeConfigManager', () => ({}));
    require('../../FileConverter/sources/convertermaster');
  });

  return {cluster, os, logger};
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('FileConverter worker count', () => {
  test('uses the explicit count instead of parallelism and the multiplier', () => {
    const {cluster} = startMaster({workercount: 3, parallelism: 8, multiplier: 2});
    expect(cluster.fork).toHaveBeenCalledTimes(3);
  });

  test('allows one worker and counts larger than the available CPU count', () => {
    expect(startMaster({workercount: 1, parallelism: 4}).cluster.fork).toHaveBeenCalledTimes(1);
    expect(startMaster({workercount: 7, parallelism: 2}).cluster.fork).toHaveBeenCalledTimes(7);
  });

  test('does not query CPU availability when the count is explicit', () => {
    const {os} = startMaster({workercount: 2});
    expect(os.cpus).not.toHaveBeenCalled();
    expect(os.availableParallelism).not.toHaveBeenCalled();
  });

  test('preserves the legacy calculation when the setting is absent', () => {
    const {cluster, logger} = startMaster({parallelism: 5, multiplier: 0.25});
    expect(cluster.fork).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.some(([message]) => message.includes('Invalid FileConverter.converter.workercount'))).toBe(false);
  });

  test('preserves an automatic zero-worker configuration', () => {
    const {cluster} = startMaster({multiplier: 0});
    expect(cluster.fork).not.toHaveBeenCalled();
  });

  test.each([null, undefined])('preserves automatic sizing without an invalid-value warning for %p', workercount => {
    const {cluster, logger} = startMaster({workercount, parallelism: 4, multiplier: 1.5});
    expect(cluster.fork).toHaveBeenCalledTimes(6);
    expect(logger.warn.mock.calls.some(([message]) => message.includes('Invalid FileConverter.converter.workercount'))).toBe(false);
  });

  test.each([0, -1, 1.5, '3', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'falls back to automatic sizing for invalid workercount %p',
    workercount => {
      const {cluster, logger} = startMaster({workercount, parallelism: 4, multiplier: 0.5});
      expect(cluster.fork).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid FileConverter.converter.workercount'), workercount);
    }
  );

  test('falls back to CPU count when availableParallelism is unavailable', () => {
    const {cluster} = startMaster({withoutAvailableParallelism: true, cpus: 6, multiplier: 0.5});
    expect(cluster.fork).toHaveBeenCalledTimes(3);
  });

  test('preserves the CPU fallback when availableParallelism returns zero', () => {
    const {cluster} = startMaster({parallelism: 0, cpus: 5, multiplier: 0.5});
    expect(cluster.fork).toHaveBeenCalledTimes(3);
  });

  test('replaces an exited worker without changing the explicit pool size', () => {
    const {cluster} = startMaster({workercount: 3, parallelism: 8});
    const worker = Object.values(cluster.workers)[0];
    delete cluster.workers[worker.process.pid];
    const onExit = cluster.on.mock.calls.find(([event]) => event === 'exit')[1];
    onExit(worker, 1, null);

    expect(cluster.fork).toHaveBeenCalledTimes(4);
    expect(Object.keys(cluster.workers)).toHaveLength(3);
  });
});
