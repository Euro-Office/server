/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {minimumRefreshedTtlSeconds, ttlMilliseconds: parseTtlMilliseconds} = require('../expirationConfig');

// The longest TTL passed to Redis. Above it, EXPIRE fails ("invalid expire
// time") and presence index scores (milliseconds) lose precision.
const MAX_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function toRedisString(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return String(value);
}

// Redis stores strings as UTF-8, which turns every lone UTF-16 surrogate into
// U+FFFD, so "a\ud800" and "a\udc00" would become the same key or field. JSON
// escaping keeps them apart (\ud800) and is reversible, so different strings
// stay different. Ids without quotes, backslashes, control characters or lone
// surrogates are unchanged.
function losslessText(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

// The inverse of losslessText, for ids that are read back.
function fromLosslessText(value) {
  const text = toRedisString(value);
  try {
    return JSON.parse(`"${text}"`);
  } catch (_e) {
    return text;
  }
}

function getCfg(ctx, path, fallback) {
  return ctx && typeof ctx.getCfg === 'function' ? ctx.getCfg(path, fallback) : fallback;
}

// A TTL in milliseconds: a positive number of seconds, or an `ms` duration
// string ("1d"). NaN for anything else, including zero, negative values and
// values above MAX_TTL_MS.
function validTtlMilliseconds(value) {
  const parsed = parseTtlMilliseconds(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TTL_MS ? parsed : NaN;
}

// Throws for an unusable TTL. The Lua scripts write before they set the TTL,
// so a TTL Redis rejects would leave the written keys without one.
function requireTtlMilliseconds(value, name) {
  const parsed = validTtlMilliseconds(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a positive duration of at most 100 years, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

// A tenant value that is not a usable TTL falls back to the global value
// (`fallback`), which is checked when the Redis backend loads.
function ttlSeconds(ctx, path, fallback) {
  const value = getCfg(ctx, path, fallback);
  let parsed = validTtlMilliseconds(value);
  if (!Number.isFinite(parsed)) {
    parsed = requireTtlMilliseconds(fallback, path);
    ctx?.logger?.warn?.('invalid %s %j; using %j instead', path, value, fallback);
  }
  return Math.ceil(parsed / 1000);
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
  return requireTtlMilliseconds(value, 'TTL');
}

// A TTL passed in by the caller (a tenant value DocsCoServer read): one that is
// not usable is replaced by fallback, so that it does not deny every lock.
function ttlOrDefault(value, fallback) {
  return Number.isFinite(validTtlMilliseconds(value)) ? value : fallback;
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
  losslessText,
  fromLosslessText,
  refreshedTtlSeconds,
  requireTtlMilliseconds,
  ttlSeconds,
  ttlMilliseconds,
  ttlOrDefault,
  jsonEncode,
  jsonDecode,
  decodeHash,
  argsFromObject,
  strictMax
};
