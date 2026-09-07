const {describe, test, expect} = require('@jest/globals');
const {buildKey, encodePair, decodePair, shardIndex} = require('../../DocService/sources/editorDataRedisKeys');

describe('editorDataRedisKeys', () => {
  describe('buildKey', () => {
    test('joins prefix, encoded tenant and encoded docId with a colon', () => {
      expect(buildKey('ds:presence:', 'localhost', 'doc-1')).toBe('ds:presence:localhost:doc-1');
    });

    test('encodes a colon inside tenant or docId so it cannot be mistaken for the separator', () => {
      expect(buildKey('ds:presence:', 'a:b', 'c')).toBe('ds:presence:a%3Ab:c');
    });
  });

  describe('encodePair / decodePair round-trip', () => {
    test('round-trips a plain (tenant, docId) pair', () => {
      expect(decodePair(encodePair('localhost', 'doc-1'))).toEqual(['localhost', 'doc-1']);
    });

    // The whole reason encodePair/decodePair exist rather than a naive
    // `${tenant}:${docId}` join: two distinct pairs must never collapse to
    // the same encoded string.
    test('round-trips a tenant or docId that itself contains a colon, without colliding with a different split of the same characters', () => {
      expect(decodePair(encodePair('a:b', 'c'))).toEqual(['a:b', 'c']);
      expect(decodePair(encodePair('a', 'b:c'))).toEqual(['a', 'b:c']);
      expect(encodePair('a:b', 'c')).not.toBe(encodePair('a', 'b:c'));
    });
  });

  describe('shardIndex', () => {
    test('is deterministic for the same tenant', () => {
      expect(shardIndex('localhost', 16)).toBe(shardIndex('localhost', 16));
    });

    test('always falls within [0, numShards)', () => {
      const tenants = ['a', 'localhost', 'tenant-with-a-long-name', '', 'a:b', 'unicode-üé'];
      for (const tenant of tenants) {
        const shard = shardIndex(tenant, 16);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(16);
      }
    });
  });
});
