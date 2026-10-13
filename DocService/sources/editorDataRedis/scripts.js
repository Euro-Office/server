/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Keep this module as the stable public surface for Redis scripts. Individual
// script groups live in ./scripts and existing callers can keep requiring
// './scripts' unchanged.
module.exports = {
  ...require('./scripts/locks'),
  ...require('./scripts/presence'),
  ...require('./scripts/expiredQueue'),
  ...require('./scripts/messages'),
  ...require('./scripts/savedState'),
  ...require('./scripts/forceSave'),
  ...require('./scripts/statistics'),
  ...require('./scripts/documentCleanup')
};
