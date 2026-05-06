/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * Embedded converter runner.
 *
 * Starts when isMemoryRuntime() is true (standalone/community edition).
 * In broker deployments this module is a no-op; convertermaster.js spawns
 * separate worker processes instead.
 */

'use strict';

const config = require('config');
const profile = require('../../Common/sources/runtime/profile');
const operationContext = require('../../Common/sources/operationContext');
const InprocTaskQueue = require('../../Common/sources/taskqueueMemory');

let started = false;
let runnerQueue = null;

/**
 * Read FileConverter.converter.maxprocesscount safely.
 * @returns {number}
 */
function readMaxProcessCount() {
  try {
    return Number(config.get('FileConverter.converter.maxprocesscount')) || 0;
  } catch (_err) {
    return 0;
  }
}

/**
 * Start the embedded converter runner. Idempotent once the runner is up.
 * @returns {Promise<void>}
 */
async function start() {
  if (started) return;
  if (!profile.isMemoryRuntime()) return;

  // Lazy-require: keeps FileConverter out of the module graph in Enterprise deployments.
  const converter = require('../../FileConverter/sources/converter');

  const maxProcessCount = readMaxProcessCount();
  if (maxProcessCount > 1) {
    operationContext.global.logger.warn(
      'embedded converter: FileConverter.converter.maxprocesscount=%d is ignored; using a single in-process subscriber',
      maxProcessCount
    );
  }

  // The queue handle on the converter side must:
  //   - publish responses (isAddResponse=true)
  //   - receive tasks (isAddTaskReceive=true)
  //   - publish tasks for retries/redelivery simulation (isAddTask=true)
  const queue = new InprocTaskQueue(converter.simulateErrorResponse);
  converter.createRunner(queue);
  await queue.initPromise(true, true, true, false, false, false);

  runnerQueue = queue;
  started = true;
  operationContext.global.logger.warn('embedded converter started');
}

/**
 * Stop the embedded converter runner. Used by tests and graceful shutdown.
 * @returns {Promise<void>}
 */
async function stop() {
  if (!started || !runnerQueue) return;
  try {
    await runnerQueue.close();
  } catch (err) {
    operationContext.global.logger.warn('embedded converter close error: %s', err && err.stack);
  } finally {
    runnerQueue = null;
    started = false;
  }
}

/**
 * @returns {boolean}
 */
function isStarted() {
  return started;
}

module.exports = {start, stop, isStarted};
