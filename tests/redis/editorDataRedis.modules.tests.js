/*
 * (c) Copyright Ascensio System SIA 2010-2025
 *
 * This program is a free software product. It can be redistributed and/or
 * modified under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation.
 */

'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');
const ms = require('../../DocService/node_modules/ms');

describe('editorDataRedis module boundaries', () => {
  test('loads each focused module without relying on base.js or creating a lease', () => {
    const manager = require('../../DocService/sources/editorDataRedis/redisConnectionManager').redisConnectionManager;
    const sizeBefore = manager.size();

    const modules = [
      '../../DocService/sources/editorDataRedis/editorCommon',
      '../../DocService/sources/editorDataRedis/editorDataSettings',
      '../../DocService/sources/editorDataRedis/editorStatSettings',
      '../../DocService/sources/editorDataRedis/redisConfig',
      '../../DocService/sources/editorDataRedis/redisConnection',
      '../../DocService/sources/editorDataRedis/redisConnectionManager',
      '../../DocService/sources/editorDataRedis/redisKeys',
      '../../DocService/sources/editorDataRedis/redisValueCodec'
    ];

    for (const modulePath of modules) {
      assert.ok(require(modulePath));
    }
    assert.equal(manager.size(), sizeBefore);
  });

  test('settings modules expose the configured expiry values without creating clients', () => {
    const config = require('../../DocService/node_modules/config');
    const expire = config.get('services.CoAuthoring.expire');
    const dataSettings = require('../../DocService/sources/editorDataRedis/editorDataSettings');
    const statSettings = require('../../DocService/sources/editorDataRedis/editorStatSettings');

    assert.equal(dataSettings.cfgExpPresence, expire.get('presence'));
    assert.equal(dataSettings.cfgExpLocks, expire.get('locks'));
    assert.equal(dataSettings.cfgExpMessage, expire.get('message'));
    assert.equal(dataSettings.cfgExpForceSave, expire.get('forcesave'));
    assert.equal(dataSettings.cfgExpSaved, expire.get('saved'));
    assert.equal(statSettings.cfgExpShard, expire.get('shard'));
    assert.equal(statSettings.cfgExpMonthUniqueUsers, ms(expire.get('monthUniqueUsers')));
  });
});
