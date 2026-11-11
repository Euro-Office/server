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

  test('treats an undefined saved state as absent, like null', async () => {
    const editorData = {getdelSaved: async () => undefined};
    assert.deepEqual(await consumeSavedState(editorData, {tenant: 'tenant'}, 'document', 'save-key'), {success: true, claimed: false});
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
  test('normalizes absence and retains a claimed status until acknowledgement', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    assert.equal(await store.getdelSaved(ctx, 'document', 'save-key'), null);
    await store.setSaved(ctx, 'document', '0');
    assert.deepEqual(await consumeSavedState(store, ctx, 'document', 'save-key'), {success: false, claimed: true});
    assert.equal(await store.getdelSaved(ctx, 'document', 'save-key'), '0');
    assert.equal(await store.ackSaved(ctx, 'document', 'save-key'), true);
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

  test('retains callback acceptance until the saved-state claim is acknowledged', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setSavedCallbackAccepted(ctx, 'document', 'save-key', {url: 'https://callback.example.test/save'});
    assert.deepEqual(await store.getSavedCallbackAccepted(ctx, 'document', 'save-key'), {url: 'https://callback.example.test/save'});
    await store.cleanDocumentOnExit(ctx, 'document', 'save-key');
    assert.deepEqual(await store.getSavedCallbackAccepted(ctx, 'document', 'save-key'), {url: 'https://callback.example.test/save'});
    await store.ackSaved(ctx, 'document', 'save-key');
    await store.clearSavedCallbackAccepted(ctx, 'document', 'save-key');
    assert.equal(await store.getSavedCallbackAccepted(ctx, 'document', 'save-key'), undefined);
  });

  test('claim-less cleanup drops claims and acceptance markers that saves left behind', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setSaved(ctx, 'document', '0');
    await store.getdelSaved(ctx, 'document', 'abandoned-save');
    await store.setSavedCallbackAccepted(ctx, 'document', 'abandoned-save', {url: 'https://callback.example.test/save'});
    await store.setSavedCallbackAccepted(ctx, 'other-document', 'save-key', {url: 'https://callback.example.test/save'});
    assert.equal(await store.cleanDocumentOnExit(ctx, 'document'), true);
    assert.equal(await store.getdelSaved(ctx, 'document', 'abandoned-save'), null);
    assert.equal(await store.getSavedCallbackAccepted(ctx, 'document', 'abandoned-save'), undefined);
    assert.deepEqual(await store.getSavedCallbackAccepted(ctx, 'other-document', 'save-key'), {url: 'https://callback.example.test/save'});
    assert.deepEqual(store.savedClaims, {});
  });

  test('acknowledging the last claim of a tenant removes the tenant entry', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setSaved(ctx, 'document', '1');
    await store.getdelSaved(ctx, 'document', 'save-key');
    await store.ackSaved(ctx, 'document', 'save-key');
    assert.deepEqual(store.savedClaims, {});
  });

  test('final-viewer cleanup keeps an unclaimed corrupted saved status', async () => {
    // A final save for the last editor can still be in flight when the last
    // viewer leaves (viewers do not block the save).  The save has not yet
    // claimed the saved status, so the final-viewer cleanup must preserve it;
    // otherwise consumeSavedState reports the corrupted save as a success and
    // the save deletes its changes.
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setSaved(ctx, 'document', '2');
    assert.equal(await store.cleanDocumentOnExit(ctx, 'document', undefined, {preserveSavedClaim: true}), true);
    assert.deepEqual(await consumeSavedState(store, ctx, 'document', 'save-key'), {success: false, claimed: true});
    assert.equal(await store.getdelSaved(ctx, 'document', 'save-key'), '2');
  });

  test('final-viewer cleanup keeps an in-flight force-save entry', async () => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setForceSave(ctx, 'document', 1, 2, 'https://callback.example.test/save', undefined, undefined);
    assert.equal(await store.cleanDocumentOnExit(ctx, 'document', undefined, {preserveSavedClaim: true}), true);
    const forceSave = await store.getForceSave(ctx, 'document');
    assert.equal(forceSave.time, 1);
    assert.equal(forceSave.index, 2);
    assert.equal(forceSave.started, false);
    assert.equal(forceSave.ended, false);
  });

  test.each([
    ['owner', 'save-key'],
    ['claim-less', undefined]
  ])('%s cleanup without preserveSavedClaim still wipes the saved status and force-save', async (_name, savedClaimId) => {
    const store = new EditorData();
    const ctx = {tenant: 'tenant'};
    await store.setSaved(ctx, 'document', '2');
    await store.setForceSave(ctx, 'document', 1, 2, 'https://callback.example.test/save', undefined, undefined);
    assert.equal(await store.cleanDocumentOnExit(ctx, 'document', savedClaimId), true);
    assert.equal(await store.getdelSaved(ctx, 'document', 'save-key'), null);
    assert.equal(await store.getForceSave(ctx, 'document'), null);
  });
});
