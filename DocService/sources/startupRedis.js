/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// RedisConnection already bounds each physical connection attempt and handles
// Sentinel/Cluster reconnect details. These values only bound how many times
// startup retries the complete editor-data/editor-stat readiness sequence.
const STARTUP_REDIS_MAX_ATTEMPTS = 3;
const STARTUP_REDIS_RETRY_DELAY_MS = 1000;

class StartupRedisCancelledError extends Error {
  constructor() {
    super('Redis startup was cancelled');
    this.name = 'StartupRedisCancelledError';
  }
}

function waitForRetry(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(new StartupRedisCancelledError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new StartupRedisCancelledError());
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function connectWithCancellation(connection, signal) {
  if (!signal) {
    return connection.connect();
  }
  if (signal.aborted) {
    return Promise.reject(new StartupRedisCancelledError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onAbort = () => {
      try {
        connection.cancelConnect?.();
      } catch (_error) {
        // The startup cancellation must still settle if client cleanup fails.
      } finally {
        finish(new StartupRedisCancelledError());
      }
    };
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve()
      .then(() => {
        if (signal.aborted) {
          throw new StartupRedisCancelledError();
        }
        return connection.connect();
      })
      .then(
        value => finish(null, value),
        error => finish(error)
      );
  });
}

function validateRetryOptions(maxAttempts, retryDelayMs) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`maxAttempts must be a positive safe integer; received ${maxAttempts}`);
  }
  if (typeof retryDelayMs !== 'number' || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError(`retryDelayMs must be a finite non-negative number; received ${retryDelayMs}`);
  }
}

async function connectRedisForStartup({
  editorData,
  editorStat,
  logger = console,
  signal,
  maxAttempts = STARTUP_REDIS_MAX_ATTEMPTS,
  retryDelayMs = STARTUP_REDIS_RETRY_DELAY_MS,
  wait = waitForRetry
}) {
  validateRetryOptions(maxAttempts, retryDelayMs);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new StartupRedisCancelledError();
    }
    try {
      await connectWithCancellation(editorData, signal);
      await connectWithCancellation(editorStat, signal);
      return;
    } catch (err) {
      if (signal?.aborted) {
        throw new StartupRedisCancelledError();
      }
      if (attempt === maxAttempts) {
        throw err;
      }
      logger.warn('Redis startup attempt %d/%d failed; retrying in %dms: %s', attempt, maxAttempts, retryDelayMs, err.message || err);
      await wait(retryDelayMs * 2 ** (attempt - 1), signal);
    }
  }
}

module.exports = {
  STARTUP_REDIS_MAX_ATTEMPTS,
  STARTUP_REDIS_RETRY_DELAY_MS,
  StartupRedisCancelledError,
  connectRedisForStartup
};
