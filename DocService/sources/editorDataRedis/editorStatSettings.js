/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const ms = require('ms');

const expire = config.get('services.CoAuthoring.expire');

module.exports = {
  cfgExpShard: expire.get('shard'),
  cfgExpMonthUniqueUsers: ms(expire.get('monthUniqueUsers'))
};
