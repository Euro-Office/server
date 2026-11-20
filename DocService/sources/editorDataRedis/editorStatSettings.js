/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const {requireTtlMilliseconds} = require('./redisValueCodec');

const expire = config.get('services.CoAuthoring.expire');

// New with this backend: fall back to the default.json value for an older
// operator-supplied default.json.
const cfgExpShard = expire.has('shard') ? expire.get('shard') : 300;
requireTtlMilliseconds(cfgExpShard, 'services.CoAuthoring.expire.shard');

module.exports = {
  cfgExpShard,
  // A number is seconds, like the other expire values (`ms(number)` would
  // format the number instead of parsing it).
  cfgExpMonthUniqueUsers: requireTtlMilliseconds(expire.get('monthUniqueUsers'), 'services.CoAuthoring.expire.monthUniqueUsers')
};
