'use strict';

require('./testSetup');

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');

const memoryStorage = require('../../DocService/sources/editorDataMemory');
const redisStorage = require('../../DocService/sources/editorDataRedis');
const redisKeys = require('../../DocService/sources/editorDataRedis/redisKeys');
const redisValueCodec = require('../../DocService/sources/editorDataRedis/redisValueCodec');
const {publicMethods} = require('./testHelpers');

const ctx = {tenant: 'tenant:世界'};

describe('editorDataRedis contract', () => {
  test('keeps the complete EditorData and EditorStat interfaces', async () => {
    const redisData = new redisStorage.EditorData();
    const memoryData = new memoryStorage.EditorData();
    const redisStat = new redisStorage.EditorStat();
    const memoryStat = new memoryStorage.EditorStat();

    try {
      assert.deepEqual(publicMethods(redisData), publicMethods(memoryData));
      assert.deepEqual(publicMethods(redisStat), publicMethods(memoryStat));

      for (const method of publicMethods(memoryData)) {
        assert.equal(redisData[method].length, memoryData[method].length, `EditorData.${method} arity changed`);
      }
      for (const method of publicMethods(memoryStat)) {
        assert.equal(redisStat[method].length, memoryStat[method].length, `EditorStat.${method} arity changed`);
      }
    } finally {
      await Promise.all([redisData.close(), redisStat.close()]);
    }
  });

  test('isolates document keys and co-locates one document for Redis Cluster', async () => {
    const data = new redisStorage.EditorData();
    const first = data._docKeys(ctx, 'doc:世界');
    const second = data._docKeys(ctx, 'other-doc');
    const otherTenant = data._docKeys({tenant: 'other'}, 'doc:世界');

    try {
      const firstHashTags = Object.values(first).map(key => key.match(/\{[^}]+\}/)?.[0]);
      assert.equal(new Set(firstHashTags).size, 1);
      assert.notEqual(first.presenceSet, second.presenceSet);
      assert.notEqual(first.presenceSet, otherTenant.presenceSet);
      assert.match(first.presenceSet, /[A-Za-z0-9_-]+$/);
      assert.equal(data.documentsKey, `${redisKeys.cfgRedisPrefix}{editor:index}:documents`);
    } finally {
      await data.close();
    }
  });

  test('keeps statistics keys tenant-scoped and separate from document keys', async () => {
    const data = new redisStorage.EditorData();
    const stat = new redisStorage.EditorStat();

    try {
      assert.equal(stat._statBase(ctx), stat._statBase({...ctx}, 'ignored'));
      assert.notEqual(stat._statBase(ctx), stat._statBase({tenant: 'other'}));
      assert.notEqual(stat._statBase(ctx), data._docBase(ctx, 'doc'));
    } finally {
      await Promise.all([data.close(), stat.close()]);
    }
  });
});

describe('editorDataRedis value helpers', () => {
  test('encodes keys without leaving tenant or document separators ambiguous', () => {
    const encoded = redisKeys.encodePart('tenant:世界/doc');
    assert.ok(!encoded.includes(':'));
    assert.ok(!encoded.includes('/'));
    assert.equal(redisKeys.encodePart('same'), redisKeys.encodePart('same'));
  });

  test('round-trips document index members and rejects malformed values', () => {
    const member = redisKeys.documentMember(ctx, 'doc:世界');
    assert.deepEqual(redisKeys.decodeDocumentMember(Buffer.from(member)), ['tenant:世界', 'doc:世界']);
    assert.equal(redisKeys.decodeDocumentMember('not-json'), null);
    assert.equal(redisKeys.decodeDocumentMember(JSON.stringify(['only-one-part'])), null);
  });

  test('normalizes numeric and duration TTLs with a one-unit minimum', () => {
    assert.equal(redisValueCodec.ttlSeconds({getCfg: () => 1.2}, 'ttl', 0), 2);
    assert.equal(redisValueCodec.ttlSeconds({getCfg: () => '1500ms'}, 'ttl', 0), 2);
    assert.equal(redisValueCodec.ttlSeconds({getCfg: () => 0}, 'ttl', 0), 1);
    assert.equal(redisValueCodec.ttlMilliseconds('1.5s'), 1500);
    assert.equal(redisValueCodec.ttlMilliseconds(0), 1);
  });

  test('handles Redis replies and JSON values defensively', () => {
    assert.equal(redisValueCodec.toRedisString(Buffer.from('世界')), '世界');
    assert.deepEqual(redisValueCodec.jsonDecode(Buffer.from('{"a":1}'), {}), {a: 1});
    assert.deepEqual(redisValueCodec.jsonDecode('invalid', {fallback: true}), {fallback: true});
    assert.equal(redisValueCodec.jsonDecode(null, 'fallback'), 'fallback');
    assert.equal(redisValueCodec.jsonEncode(undefined), 'null');
    assert.deepEqual(redisValueCodec.decodeHash(['a', '{"x":1}', 'b', 'invalid']), {a: {x: 1}, b: null});
    assert.deepEqual(redisValueCodec.decodeHash(null), {});
    assert.deepEqual(redisValueCodec.argsFromObject(Object.assign(Object.create({inherited: true}), {own: 'value'})), ['own', '"value"']);
    assert.equal(redisValueCodec.strictMax(2.1), '2');
  });
});
