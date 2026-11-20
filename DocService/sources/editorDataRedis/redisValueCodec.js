/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const ms = require('ms');
const {minimumRefreshedTtlSeconds} = require('../expirationConfig');

function toRedisString(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return String(value);
}

function getCfg(ctx, path, fallback) {
  return ctx && typeof ctx.getCfg === 'function' ? ctx.getCfg(path, fallback) : fallback;
}

function ttlSeconds(ctx, path, fallback) {
  const value = getCfg(ctx, path, fallback);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.ceil(numeric));
  }
  return Math.max(1, Math.ceil(ms(value) / 1000));
}

// Presence and connection shard counters are refreshed once per refresh
// interval, which DocService checks against the global TTLs only. A tenant or
// runtime value is raised to the shortest TTL that outlives one interval, or
// live entries would expire between two refreshes.
function refreshedTtlSeconds(ctx, path, globalValue) {
  const ttl = ttlSeconds(ctx, path, globalValue);
  const minimum = minimumRefreshedTtlSeconds();
  return minimum === undefined ? ttl : Math.max(ttl, minimum);
}

function ttlMilliseconds(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.ceil(numeric * 1000));
  }
  return Math.max(1, Math.ceil(ms(value)));
}

function jsonEncode(value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function jsonDecode(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(toRedisString(value));
  } catch (_e) {
    return fallback;
  }
}

function pairsToObject(value) {
  if (!value) {
    return {};
  }
  if (!Array.isArray(value)) {
    return value;
  }
  const result = {};
  for (let i = 0; i + 1 < value.length; i += 2) {
    result[toRedisString(value[i])] = value[i + 1];
  }
  return result;
}

function decodeHash(value) {
  const raw = pairsToObject(value);
  const result = {};
  for (const field in raw) {
    if (Object.hasOwn(raw, field)) {
      result[field] = jsonDecode(raw[field], null);
    }
  }
  return result;
}

function argsFromObject(value) {
  const result = [];
  for (const field in value) {
    if (Object.hasOwn(value, field)) {
      result.push(field, jsonEncode(value[field]));
    }
  }
  return result;
}

function strictMax(now) {
  return String(Math.ceil(Number(now)) - 1);
}

module.exports = {
  toRedisString,
  refreshedTtlSeconds,
  ttlSeconds,
  ttlMilliseconds,
  jsonEncode,
  jsonDecode,
  decodeHash,
  argsFromObject,
  strictMax
};
