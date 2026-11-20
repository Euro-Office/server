/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

function startHttpServer({server, startupError, logger, shutdown, exit = process.exit, port, onListening}) {
  if (startupError) {
    logger.error('Document server startup failed: %s', startupError.stack || startupError.message || startupError);
    void shutdown('startup', 1)
      .then(exit)
      .catch(error => {
        logger.error('Document server startup shutdown failed: %s', error.stack || error.message || error);
        exit(1);
      });
    return false;
  }

  server.listen(port, onListening);
  return true;
}

module.exports = {startHttpServer};
