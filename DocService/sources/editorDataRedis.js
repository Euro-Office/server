/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Compatibility entry point for the pkg configuration and existing consumers.
// Keep the implementation split under ./editorDataRedis while preserving the
// historical ./sources/editorDataRedis.js module path.
module.exports = require('./editorDataRedis/index.js');
