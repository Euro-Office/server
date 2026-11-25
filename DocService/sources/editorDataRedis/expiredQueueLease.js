/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// How long a claimed expired-queue item stays leased. gc.js reads it on every
// deployment, so this module must not load the Redis backend's settings (they
// check Redis-only configuration when they load).
const POP_EXPIRED_LEASE_MS = 5 * 60 * 1000;

module.exports = {POP_EXPIRED_LEASE_MS};
