/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const {EDITOR_INDEX_SHARD_COUNT} = require('./redisKeys');
const {requireTtlMilliseconds} = require('./redisValueCodec');

const expire = config.get('services.CoAuthoring.expire');

// Tenant values that are not usable TTLs fall back to these global values, so
// the global values themselves must be usable (see ttlSeconds). saveLock and
// lockDoc are passed to lockSave/lockAuth by DocsCoServer.
for (const name of ['presence', 'locks', 'message', 'forcesave', 'saved', 'savedClaim', 'saveLock', 'lockDoc']) {
  if (expire.has(name)) {
    requireTtlMilliseconds(expire.get(name), `services.CoAuthoring.expire.${name}`);
  }
}

// This is a per-shard limit; POP_EXPIRED_MAX_BATCH_SIZE is the aggregate
// limit for one expiration queue across all fixed index shards.
const POP_EXPIRED_BATCH_SIZE = 6;
const POP_EXPIRED_MAX_BATCH_SIZE = EDITOR_INDEX_SHARD_COUNT * POP_EXPIRED_BATCH_SIZE;
const {POP_EXPIRED_LEASE_MS} = require('./expiredQueueLease');

module.exports = {
  cfgExpPresence: expire.get('presence'),
  cfgExpLocks: expire.get('locks'),
  cfgExpMessage: expire.get('message'),
  cfgExpForceSave: expire.get('forcesave'),
  cfgExpSaved: expire.get('saved'),
  // Checked above; the fallbacks for lockSave and lockAuth (DocsCoServer locks
  // a document for 2 * lockDoc).
  cfgExpSaveLock: expire.has('saveLock') ? expire.get('saveLock') : 60,
  cfgExpAuthLockSeconds:
    (2 * requireTtlMilliseconds(expire.has('lockDoc') ? expire.get('lockDoc') : 30, 'services.CoAuthoring.expire.lockDoc')) / 1000,
  // New with this backend: fall back to the default.json value for an older
  // operator-supplied default.json.
  cfgExpSavedClaim: expire.has('savedClaim') ? expire.get('savedClaim') : 86400,
  POP_EXPIRED_BATCH_SIZE,
  POP_EXPIRED_MAX_BATCH_SIZE,
  POP_EXPIRED_LEASE_MS
};
