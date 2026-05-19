/*
 * Copyright (C) Ascensio System SIA, 2009-2026
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation, together with the
 * additional terms provided in the LICENSE file.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. For
 * details, see the GNU AGPL at: https://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA by email at info@onlyoffice.com
 * or by postal mail at 20A-6 Ernesta Birznieka-Upisha Street, Riga,
 * LV-1050, Latvia, European Union.
 *
 * The interactive user interfaces in modified versions of the Program
 * are required to display Appropriate Legal Notices in accordance with
 * Section 5 of the GNU AGPL version 3.
 *
 * No trademark rights are granted under this License.
 *
 * All non-code elements of the Product, including illustrations,
 * icon sets, and technical writing content, are licensed under the
 * Creative Commons Attribution-ShareAlike 4.0 International License:
 * https://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 * This license applies only to such non-code elements and does not
 * modify or replace the licensing terms applicable to the Program's
 * source code, which remains licensed under the GNU Affero General
 * Public License v3.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/*
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

let startPromise = null;
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

async function _doStart() {
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
  operationContext.global.logger.warn('embedded converter started');
}

/**
 * Start the embedded converter runner. Idempotent - concurrent calls share the same Promise.
 * A failed start clears the promise so the caller can retry.
 * @returns {Promise<void>}
 */
function start() {
  if (!startPromise) {
    startPromise = _doStart().catch(err => {
      startPromise = null;
      throw err;
    });
  }
  return startPromise;
}

/**
 * Stop the embedded converter runner. Used by tests and graceful shutdown.
 * @returns {Promise<void>}
 */
async function stop() {
  startPromise = null;
  if (!runnerQueue) return;
  try {
    await runnerQueue.close();
  } catch (err) {
    operationContext.global.logger.warn('embedded converter close error: %s', err && err.stack);
  } finally {
    runnerQueue = null;
  }
}

/**
 * @returns {boolean}
 */
function isStarted() {
  return runnerQueue !== null;
}

module.exports = {start, stop, isStarted};
