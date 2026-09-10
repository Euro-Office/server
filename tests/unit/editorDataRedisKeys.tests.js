const {describe, test, expect} = require('@jest/globals');
const {buildKey, encodePair, decodePair, shardIndex} = require('../../DocService/sources/editorDataRedisKeys');
// The slot function ioredis routes cluster commands with.
const calculateSlot = require('../../DocService/node_modules/cluster-key-slot');

describe('editorDataRedisKeys', () => {
  describe('buildKey', () => {
    test('joins prefix, encoded tenant and encoded docId, hash-tagged for Redis Cluster', () => {
      expect(buildKey('ds:presence:', 'localhost', 'doc-1')).toBe('ds:presence:{localhost:doc-1}');
    });

    test('encodes a colon inside tenant or docId so it cannot be mistaken for the separator', () => {
      expect(buildKey('ds:presence:', 'a:b', 'c')).toBe('ds:presence:{a%3Ab:c}');
    });

    // The hash tag is what keeps a document's keys on one slot. Everything
    // outside the braces - the prefix that distinguishes the four key kinds -
    // must stay out of the hashed portion, or the two-key presence scripts
    // and the two-key DELs go CROSSSLOT on a cluster.
    //
    // Slots come from cluster-key-slot, which is the module ioredis itself
    // routes with, so this asserts the real routing decision rather than a
    // re-implementation of CRC16. (redis-memory-server runs with cluster
    // support disabled, so CLUSTER KEYSLOT is not available to ask.)
    describe('Redis Cluster hash slots', () => {
      const KEY_KINDS = ['ds:lockSave:', 'ds:lockAuth:', 'ds:presence:', 'ds:presenceExp:'];

      test('every key of one document lands on one slot', () => {
        const slots = KEY_KINDS.map(prefix => calculateSlot(buildKey(prefix, 'localhost', 'doc-1')));
        expect(new Set(slots).size).toBe(1);
      });

      test('without the hash tag they did not, which is the CROSSSLOT regression this guards', () => {
        const untagged = KEY_KINDS.map(prefix => calculateSlot(`${prefix}localhost:doc-1`));
        expect(new Set(untagged).size).toBeGreaterThan(1);
      });

      test('co-locating one document does not collapse every document onto one slot', () => {
        const perDoc = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5'].map(docId => calculateSlot(buildKey('ds:presence:', 'localhost', docId)));
        expect(new Set(perDoc).size).toBeGreaterThan(1);
      });

      // The reporting deployment published the slots its cluster computed
      // for the patched keys. Pinning one of them keeps our key format
      // byte-identical to the build their measurements describe.
      test('matches the key format measured on the reporting deployment (slot 14056)', () => {
        expect(buildKey('ds:presence:', 'localhost', 'doc1')).toBe('ds:presence:{localhost:doc1}');
        expect(calculateSlot('ds:presence:{localhost:doc1}')).toBe(14056);
      });
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
    test('is deterministic for the same (tenant, docId) pair - track() and untrack() must always agree on the shard', () => {
      expect(shardIndex('localhost', 'doc-1', 16)).toBe(shardIndex('localhost', 'doc-1', 16));
    });

    test('always falls within [0, numShards)', () => {
      const pairs = [
        ['a', 'x'],
        ['localhost', 'doc-1'],
        ['tenant-with-a-long-name', 'doc'],
        ['', ''],
        ['a:b', 'c'],
        ['unicode-üé', 'doc']
      ];
      for (const [tenant, docId] of pairs) {
        const shard = shardIndex(tenant, docId, 16);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(16);
      }
    });

    // The actual bug this guards: a single-tenant deployment (the common
    // case) must not hash every document to the same one shard - that
    // would defeat the entire point of sharding for exactly the
    // deployment shape it matters most for.
    test('distributes different docIds under the same tenant across more than one shard', () => {
      const shards = new Set();
      for (let i = 0; i < 64; i++) {
        shards.add(shardIndex('localhost', `doc-${i}`, 16));
      }
      expect(shards.size).toBeGreaterThan(1);
    });
  });
});
