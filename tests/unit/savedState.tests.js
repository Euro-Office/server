/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const assert = require('node:assert/strict');
const {describe, test} = require('@jest/globals');

const {consumeSavedState} = require('../../DocService/sources/savedState');

describe('canvasservice saved-state decision', () => {
  test('treats an absent saved state as successful without acknowledging', async () => {
    let acknowledgements = 0;
    const editorData = {
      async getdelSaved() {
        return null;
      },
      async ackSaved() {
        acknowledgements++;
      }
    };

    assert.deepEqual(await consumeSavedState(editorData, {}, 'document', 'operation-a'), {success: true, claimed: false});
    assert.equal(acknowledgements, 0);
  });

  test('leaves a successful saved-state claim for acknowledgement after cleanup', async () => {
    const calls = [];
    const editorData = {
      async getdelSaved() {
        calls.push('claim');
        return '1';
      },
      async ackSaved(_ctx, _docId, operationId) {
        calls.push(`ack:${operationId}`);
      }
    };

    assert.deepEqual(await consumeSavedState(editorData, {}, 'document', 'operation-a'), {success: true, claimed: true});
    assert.deepEqual(calls, ['claim']);
  });

  test('keeps a non-success saved status on the forgotten-file path', async () => {
    let acknowledged = false;
    const editorData = {
      async getdelSaved() {
        return '0';
      },
      async ackSaved() {
        acknowledged = true;
      }
    };

    assert.deepEqual(await consumeSavedState(editorData, {}, 'document', 'operation-a'), {success: false, claimed: true});
    assert.equal(acknowledged, false);
  });

  test('propagates unknown or Redis errors so cleanup cannot proceed', async () => {
    for (const error of [Object.assign(new Error('saved state unknown'), {code: 'EDITOR_DATA_SAVED_UNKNOWN'}), new Error('Redis unavailable')]) {
      const editorData = {
        async getdelSaved() {
          throw error;
        },
        async ackSaved() {
          throw new Error('acknowledgement must not be attempted');
        }
      };

      await assert.rejects(consumeSavedState(editorData, {}, 'document', 'operation-a'), rejected => rejected === error);
    }
  });
});

const {EditorData} = require('../../DocService/sources/editorDataMemory');

describe('memory saved-state contract', () => {
  test('normalizes absence and consumes a saved status once', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    assert.equal(await store.getdelSaved(ctx, 'document', 'save-key'), null);
    await store.setSaved(ctx, 'document', '0');
    assert.deepEqual(await consumeSavedState(store, ctx, 'document', 'save-key'), {success: false, claimed: true});
    assert.equal(await store.getdelSaved(ctx, 'document', 'save-key'), null);
    await store.setSaved(ctx, 'document', '1');
    assert.deepEqual(await consumeSavedState(store, ctx, 'document', 'next-save'), {success: true, claimed: true});
  });

  test('cleanup removes document state and timers; acknowledgement never recreates them', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setSaved(ctx, 'document', '0');
    await store.addForceSaveTimerNX(ctx, 'document', 1);
    assert.equal(await store.cleanDocumentOnExit(ctx, 'document', 'save-key'), true);
    assert.equal(await store.ackSaved(ctx, 'document', 'save-key'), true);
    assert.equal(await store.ackSaved(ctx, 'document', 'save-key'), true);
    assert.equal(Object.hasOwn(store.data[ctx.tenant], 'document'), false);
    assert.deepEqual(await store.getForceSaveTimer(2), []);
  });
});
