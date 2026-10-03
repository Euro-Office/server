/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const REDIS_TIME_MILLIS = `
local function redisTimeMillis()
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
`;

module.exports = {REDIS_TIME_MILLIS};
