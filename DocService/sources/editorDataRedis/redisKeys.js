/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const config = require('config');
const {toRedisString} = require('./redisValueCodec');

const cfgRedisPrefix = config.get('services.CoAuthoring.redis').get('prefix');

function encodePart(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function tenantName(ctx) {
  return ctx && ctx.tenant !== undefined && ctx.tenant !== null ? String(ctx.tenant) : '';
}

function documentMember(ctx, docId) {
  return JSON.stringify([tenantName(ctx), String(docId)]);
}

function decodeDocumentMember(value) {
  try {
    const parsed = JSON.parse(toRedisString(value));
    return Array.isArray(parsed) && parsed.length === 2 ? parsed : null;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  cfgRedisPrefix,
  encodePart,
  tenantName,
  documentMember,
  decodeDocumentMember
};
