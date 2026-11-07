/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const ms = require('ms');

const DEFAULT_SHUTDOWN_TIMEOUT = 10000;

function resolveShutdownTimeout(value, defaultTimeout = DEFAULT_SHUTDOWN_TIMEOUT) {
  let timeout;
  try {
    timeout = ms(value);
  } catch (_error) {
    return defaultTimeout;
  }
  return Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeout;
}

function destroySockets(sockets) {
  for (const socket of sockets) {
    socket.destroy();
  }
}

function trackUpgradedSockets(server, isShuttingDown) {
  const sockets = new Set();

  server.on('upgrade', (_request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (isShuttingDown()) {
      socket.destroy();
    }
  });

  return sockets;
}

function waitForServerClose(server, upgradedSockets, {timeout = DEFAULT_SHUTDOWN_TIMEOUT, logger, closeSocketIo} = {}) {
  if (!server.listening) {
    return Promise.resolve()
      .then(() => closeSocketIo?.())
      .catch(error => {
        logger?.error('Socket.IO server close error: %s', error.stack || error.message || error);
      })
      .then(() => {
        destroySockets(upgradedSockets);
        return false;
      });
  }

  return new Promise(resolve => {
    let settled = false;
    let serverClosed = false;
    let socketIoClosed = false;
    const shutdownTimeout = setTimeout(() => {
      logger?.warn('HTTP server shutdown timed out; forcing remaining connections closed');
      destroySockets(upgradedSockets);
      server.closeAllConnections?.();
      finish(true);
    }, timeout);

    const finish = forced => {
      if (settled) {
        return;
      }
      if (!forced && (!serverClosed || !socketIoClosed)) {
        return;
      }
      settled = true;
      clearTimeout(shutdownTimeout);
      resolve(forced);
    };

    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        logger?.error('HTTP server close error: %s', error.stack || error.message || error);
      }
      serverClosed = true;
      finish(false);
    });
    server.closeIdleConnections?.();
    try {
      Promise.resolve(closeSocketIo?.())
        .catch(error => {
          logger?.error('Socket.IO server close error: %s', error.stack || error.message || error);
        })
        .finally(() => {
          socketIoClosed = true;
          finish(false);
        });
    } catch (error) {
      logger?.error('Socket.IO server close error: %s', error.stack || error.message || error);
      socketIoClosed = true;
      finish(false);
    }
    destroySockets(upgradedSockets);
  });
}

function installShutdownHandlers({processObject = process, logger, shutdown, exit = process.exit} = {}) {
  const requestShutdown = (signal, exitCode = 0) => {
    Promise.resolve()
      .then(() => shutdown(signal, exitCode))
      .then(shutdownExitCode => exit(shutdownExitCode ?? exitCode))
      .catch(error => {
        logger.error('Shutdown error (%s):%s', signal, error.stack || error.message || error);
        exit(exitCode);
      });
  };
  const handleUncaughtException = error => {
    logger.error('uncaughtException:%s', error?.stack || error);
    requestShutdown('uncaughtException', 1);
  };
  const handleUnhandledRejection = reason => {
    logger.error('unhandledRejection:%s', reason?.stack || reason);
    requestShutdown('unhandledRejection', 1);
  };
  const handleSigterm = () => requestShutdown('SIGTERM');
  const handleSigint = () => requestShutdown('SIGINT');

  processObject.on('uncaughtException', handleUncaughtException);
  processObject.on('unhandledRejection', handleUnhandledRejection);
  processObject.once('SIGTERM', handleSigterm);
  processObject.once('SIGINT', handleSigint);

  return () => {
    processObject.off('uncaughtException', handleUncaughtException);
    processObject.off('unhandledRejection', handleUnhandledRejection);
    processObject.off('SIGTERM', handleSigterm);
    processObject.off('SIGINT', handleSigint);
  };
}

module.exports = {
  installShutdownHandlers,
  resolveShutdownTimeout,
  trackUpgradedSockets,
  waitForServerClose
};
