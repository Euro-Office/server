/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');

const expire = config.get('services.CoAuthoring.expire');

const POP_EXPIRED_BATCH_SIZE = 100;
const POP_EXPIRED_LEASE_MS = 5 * 60 * 1000;

module.exports = {
  cfgExpPresence: expire.get('presence'),
  cfgExpLocks: expire.get('locks'),
  cfgExpMessage: expire.get('message'),
  cfgExpForceSave: expire.get('forcesave'),
  cfgExpSaved: expire.get('saved'),
  POP_EXPIRED_BATCH_SIZE,
  POP_EXPIRED_LEASE_MS
};
