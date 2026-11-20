/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const ms = require('ms');

const expire = config.get('services.CoAuthoring.expire');

module.exports = {
  // New with this backend: fall back to the default.json value for an older
  // operator-supplied default.json.
  cfgExpShard: expire.has('shard') ? expire.get('shard') : 300,
  cfgExpMonthUniqueUsers: ms(expire.get('monthUniqueUsers'))
};
