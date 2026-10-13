/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const {EDITOR_INDEX_SHARD_COUNT} = require('./redisKeys');

const expire = config.get('services.CoAuthoring.expire');

// This is a per-shard limit; POP_EXPIRED_MAX_BATCH_SIZE is the aggregate
// limit for one expiration queue across all fixed index shards.
const POP_EXPIRED_BATCH_SIZE = 6;
const POP_EXPIRED_MAX_BATCH_SIZE = EDITOR_INDEX_SHARD_COUNT * POP_EXPIRED_BATCH_SIZE;
const POP_EXPIRED_LEASE_MS = 5 * 60 * 1000;

module.exports = {
  cfgExpPresence: expire.get('presence'),
  cfgExpLocks: expire.get('locks'),
  cfgExpMessage: expire.get('message'),
  cfgExpForceSave: expire.get('forcesave'),
  cfgExpSaved: expire.get('saved'),
  cfgExpSavedClaim: expire.get('savedClaim'),
  POP_EXPIRED_BATCH_SIZE,
  POP_EXPIRED_MAX_BATCH_SIZE,
  POP_EXPIRED_LEASE_MS
};
