/*
 * Copyright (C) Ascensio System SIA, 2009-2026
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation, together with the
 * additional terms provided in the LICENSE file.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. For
 * details, see the GNU AGPL at: https://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA by email at info@onlyoffice.com
 * or by postal mail at 20A-6 Ernesta Birznieka-Upisha Street, Riga,
 * LV-1050, Latvia, European Union.
 *
 * The interactive user interfaces in modified versions of the Program
 * are required to display Appropriate Legal Notices in accordance with
 * Section 5 of the GNU AGPL version 3.
 *
 * No trademark rights are granted under this License.
 *
 * All non-code elements of the Product, including illustrations,
 * icon sets, and technical writing content, are licensed under the
 * Creative Commons Attribution-ShareAlike 4.0 International License:
 * https://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 * This license applies only to such non-code elements and does not
 * modify or replace the licensing terms applicable to the Program's
 * source code, which remains licensed under the GNU Affero General
 * Public License v3.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {describe, test, expect} = require('@jest/globals');
const fs = require('fs');
const path = require('path');

process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || path.join(__dirname, '..', '..', 'Common', 'config');

const memoryGuard = require('../../Common/sources/runtime/memoryGuard');

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('memoryGuard.computeDocumentBudget', () => {
  test('150MB / 4 == 37.5MB', () => {
    expect(memoryGuard.computeDocumentBudget(150 * MB)).toBe(Math.floor((150 * MB) / 4));
    expect(memoryGuard.computeDocumentBudget(150 * MB)).toBe(Math.floor(37.5 * MB));
  });

  test('0 / null / undefined / invalid -> 20MB default budget', () => {
    expect(memoryGuard.computeDocumentBudget(0)).toBe(20 * MB);
    expect(memoryGuard.computeDocumentBudget(null)).toBe(20 * MB);
    expect(memoryGuard.computeDocumentBudget(undefined)).toBe(20 * MB);
    expect(memoryGuard.computeDocumentBudget(NaN)).toBe(20 * MB);
    expect(memoryGuard.computeDocumentBudget(-1)).toBe(20 * MB);
    expect(memoryGuard.computeDocumentBudget('not a number')).toBe(20 * MB);
  });

  test('1GB / 4 == 256MB', () => {
    expect(memoryGuard.computeDocumentBudget(1 * GB)).toBe(256 * MB);
  });

  test('minimum 20MB floor when derived budget is smaller', () => {
    // 40MB / 4 = 10MB -> floored to 20MB
    expect(memoryGuard.computeDocumentBudget(40 * MB)).toBe(20 * MB);
    // 160MB / 4 = 40MB > 20MB -> 40MB
    expect(memoryGuard.computeDocumentBudget(160 * MB)).toBe(40 * MB);
  });
});

describe('memoryGuard.computeEffectiveDocLimit', () => {
  test('smaller heap limit yields smaller effective limit', () => {
    const small = memoryGuard.computeEffectiveDocLimit(512 * MB, 20 * MB);
    const big = memoryGuard.computeEffectiveDocLimit(4 * GB, 20 * MB);
    expect(big).toBeGreaterThan(small);
  });

  test('larger document budget yields smaller effective limit', () => {
    const tight = memoryGuard.computeEffectiveDocLimit(4 * GB, 100 * MB);
    const loose = memoryGuard.computeEffectiveDocLimit(4 * GB, 20 * MB);
    expect(loose).toBeGreaterThan(tight);
  });

  test('zero or negative heap / budget produces zero', () => {
    expect(memoryGuard.computeEffectiveDocLimit(0, 20 * MB)).toBe(0);
    expect(memoryGuard.computeEffectiveDocLimit(4 * GB, 0)).toBe(0);
  });
});

describe('memoryGuard.checkAdmission', () => {
  function admissionInput(overrides = {}) {
    return Object.assign(
      {
        heapStats: {heap_size_limit: 4 * GB, used_heap_size: 100 * MB},
        maxChangesSizeBytes: 150 * MB,
        isMemoryRuntime: true,
        isView: false,
        isLiveViewer: false,
        openEditableDocs: 0,
        isNewEditableDoc: true
      },
      overrides
    );
  }

  test('non-memory runtime is always allowed', () => {
    const v = memoryGuard.checkAdmission(
      admissionInput({
        isMemoryRuntime: false,
        openEditableDocs: 999999
      })
    );
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('not_memory_runtime');
  });

  test('reconnect into an already-open editable docId is allowed (isNewEditableDoc=false)', () => {
    // Reconnect is NOT a free pass on its own; the only free case is that another
    // editor is already holding the same docId. Force a tight effective limit and
    // verify that capacity is bypassed only because the slot is already claimed.
    const v = memoryGuard.checkAdmission(
      admissionInput({
        heapStats: {heap_size_limit: 300 * MB, used_heap_size: 0},
        openEditableDocs: 999999,
        isNewEditableDoc: false
      })
    );
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('existing_doc');
  });

  test('viewer / liveviewer session is not counted and is allowed', () => {
    expect(
      memoryGuard.checkAdmission(
        admissionInput({
          isView: true,
          openEditableDocs: 999999
        })
      ).reason
    ).toBe('viewer');
    expect(
      memoryGuard.checkAdmission(
        admissionInput({
          isLiveViewer: true,
          openEditableDocs: 999999
        })
      ).reason
    ).toBe('viewer');
  });

  test('existing editable docId at capacity is allowed (same-doc editors do not consume a new slot)', () => {
    // Force a tight effective limit via a small heap (no configurable hard cap).
    const v = memoryGuard.checkAdmission(
      admissionInput({
        heapStats: {heap_size_limit: 300 * MB, used_heap_size: 0},
        openEditableDocs: 50,
        isNewEditableDoc: false
      })
    );
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('existing_doc');
  });

  test('new docId at capacity is denied with reason=capacity', () => {
    // Heap small enough that effectiveDocLimit becomes 0.
    const v = memoryGuard.checkAdmission(
      admissionInput({
        heapStats: {heap_size_limit: 256 * MB, used_heap_size: 0},
        openEditableDocs: 0,
        isNewEditableDoc: true
      })
    );
    expect(v.effectiveDocLimit).toBe(0);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('capacity');
  });

  test('heap pressure denies a new doc even when capacity is fine', () => {
    const v = memoryGuard.checkAdmission(
      admissionInput({
        heapStats: {heap_size_limit: 1 * GB, used_heap_size: 950 * MB},
        maxChangesSizeBytes: 0, // -> 20MB doc budget
        openEditableDocs: 0
      })
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('heap_pressure');
  });

  test('maxChangesSize=0 does not disable the guard (uses 20MB budget)', () => {
    const v = memoryGuard.checkAdmission(
      admissionInput({
        maxChangesSizeBytes: 0
      })
    );
    expect(v.documentBudgetBytes).toBe(20 * MB);
  });
});

describe('memoryGuard.countOpenEditableDocs / hasOpenEditableDoc', () => {
  function conn(docId, view, isCloseCoAuthoring) {
    return {
      docId,
      user: {view: !!view},
      isCloseCoAuthoring: !!isCloseCoAuthoring
    };
  }

  test('counts unique editable docIds; ignores viewer / closed connections', () => {
    const connections = [
      conn('A', false),
      conn('A', false), // second editor in same doc — must not increase count
      conn('B', false),
      conn('C', true), // viewer
      conn('D', false, true) // closed
    ];
    expect(memoryGuard.countOpenEditableDocs(connections)).toBe(2);
  });

  test('excludes the candidate connection itself', () => {
    const candidate = conn('NEW', false);
    const connections = [conn('A', false), candidate];
    expect(memoryGuard.countOpenEditableDocs(connections, candidate)).toBe(1);
  });

  test('hasOpenEditableDoc detects pre-existing editor on the same docId', () => {
    const candidate = conn('A', false);
    const connections = [conn('A', false), candidate];
    expect(memoryGuard.hasOpenEditableDoc(connections, 'A', candidate)).toBe(true);
    expect(memoryGuard.hasOpenEditableDoc(connections, 'B', candidate)).toBe(false);
  });

  test('hasOpenEditableDoc ignores viewer connections on the same docId', () => {
    const candidate = conn('A', false);
    const connections = [conn('A', true), candidate];
    expect(memoryGuard.hasOpenEditableDoc(connections, 'A', candidate)).toBe(false);
  });
});

describe('memoryGuard — no public config surface', () => {
  test('module does not expose getConfig / getPolicy / setters', () => {
    expect(typeof memoryGuard.getConfig).toBe('undefined');
    expect(typeof memoryGuard.getPolicy).toBe('undefined');
    expect(typeof memoryGuard.setPolicy).toBe('undefined');
    expect(typeof memoryGuard.setEnabled).toBe('undefined');
    expect(typeof memoryGuard.disable).toBe('undefined');
  });

  test('checkAdmission ignores any extra config-like fields callers may pass', () => {
    // Even if a caller tries to inject "enabled: false" or a custom hard cap,
    // the guard must still fire on a new doc at capacity.
    const v = memoryGuard.checkAdmission({
      heapStats: {heap_size_limit: 256 * MB, used_heap_size: 0},
      maxChangesSizeBytes: 0,
      isMemoryRuntime: true,
      isView: false,
      isLiveViewer: false,
      openEditableDocs: 0,
      isNewEditableDoc: true,
      // attempted overrides — must have no effect
      enabled: false,
      guardConfig: {enabled: false, maxOpenEditableHardCap: 999999}
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('capacity');
  });

  test('default.json does NOT contain services.CoAuthoring.community.memoryGuard', () => {
    const defaultPath = path.join(__dirname, '..', '..', 'Common', 'config', 'default.json');
    const cfg = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
    const coAuth = cfg && cfg.services && cfg.services.CoAuthoring;
    expect(coAuth).toBeDefined();
    // either no `community` key at all, or no `memoryGuard` inside it.
    if (coAuth.community !== undefined) {
      expect(coAuth.community.memoryGuard).toBeUndefined();
    }
  });

  test('internal policy constants match the documented Iteration-1 values', () => {
    expect(memoryGuard._internals.DIVISOR).toBe(4);
    expect(memoryGuard._internals.MIN_DOCUMENT_BUDGET_BYTES).toBe(20 * MB);
    expect(memoryGuard._internals.BASE_RESERVE_BYTES).toBe(256 * MB);
    expect(memoryGuard._internals.HEAP_CAPACITY_RATIO).toBeCloseTo(1.0);
    expect(memoryGuard._internals.HEAP_PRESSURE_RATIO).toBeCloseTo(0.9);
  });
});
