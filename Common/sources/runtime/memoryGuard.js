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

/*
 * CE memory guard — Iteration 1 (admission only).
 *
 * Limits the number of concurrently open editable documents in the
 * Community / memory runtime. The policy is intentionally NOT configurable
 * in Iteration 1: there is no `services.CoAuthoring.community.memoryGuard`
 * config block, no enable/disable switch, no tunable thresholds.
 *
 * The only public-config input that influences behavior is the existing
 * `services.CoAuthoring.editor.maxChangesSize`, which is read by the caller
 * and passed into `checkAdmission` as the basis for the per-document budget:
 *
 *   documentBudget = max(maxChangesSize / DIVISOR, MIN_DOCUMENT_BUDGET_BYTES)
 *
 * `maxChangesSize = 0 / null / invalid` does NOT disable the guard — it
 * falls through to MIN_DOCUMENT_BUDGET_BYTES.
 *
 * See docs/memory-guard-plan.md §5 for the design.
 */

'use strict';

const v8 = require('v8');

const profile = require('./profile');

// Internal, non-configurable policy. Do not surface these via public config.
const DIVISOR = 4;
const MIN_DOCUMENT_BUDGET_BYTES = 20 * 1024 * 1024;
const BASE_RESERVE_BYTES = 256 * 1024 * 1024;
const HEAP_CAPACITY_RATIO = 1.0;
const HEAP_PRESSURE_RATIO = 0.9;

/**
 * documentBudget = max(maxChangesSize / DIVISOR, MIN_DOCUMENT_BUDGET_BYTES).
 * maxChangesSize=0/null/undefined/NaN/negative/string-garbage → MIN.
 */
function computeDocumentBudget(maxChangesSizeBytes) {
  let derived = 0;
  if (typeof maxChangesSizeBytes === 'number' && Number.isFinite(maxChangesSizeBytes) && maxChangesSizeBytes > 0) {
    derived = maxChangesSizeBytes / DIVISOR;
  }
  return Math.max(Math.floor(derived), MIN_DOCUMENT_BUDGET_BYTES);
}

/**
 * effectiveDocLimit =
 *   floor((heapLimit * HEAP_CAPACITY_RATIO - BASE_RESERVE_BYTES) / documentBudget)
 */
function computeEffectiveDocLimit(heapLimitBytes, documentBudgetBytes) {
  if (!(heapLimitBytes > 0) || !(documentBudgetBytes > 0)) {
    return 0;
  }
  const plannedHeapForDocs = heapLimitBytes * HEAP_CAPACITY_RATIO - BASE_RESERVE_BYTES;
  return Math.max(0, Math.floor(plannedHeapForDocs / documentBudgetBytes));
}

/**
 * Admission decision for a candidate editable session. Pure function.
 *
 *   heapStats           — v8.HeapStatistics-like { heap_size_limit, used_heap_size }
 *   maxChangesSizeBytes — parsed tenEditor.maxChangesSize (0/null ok)
 *   isMemoryRuntime     — boolean (caller passes profile.isMemoryRuntime())
 *   isView              — conn.user.view
 *   isLiveViewer        — true for live viewer sessions
 *   openEditableDocs    — current count of unique editable docIds
 *   isNewEditableDoc    — true when this session opens a docId with no other editor yet
 *
 * Reconnect/restore is NOT a free pass on its own — the only free case is an
 * already-open editable docId (signaled by isNewEditableDoc=false).
 *
 * Returns { allowed, reason, documentBudgetBytes, effectiveDocLimit }.
 */
function checkAdmission(input) {
  const {heapStats, maxChangesSizeBytes, isMemoryRuntime, isView, isLiveViewer, openEditableDocs, isNewEditableDoc} = input;

  const documentBudgetBytes = computeDocumentBudget(maxChangesSizeBytes);
  const heapLimitBytes = heapStats && heapStats.heap_size_limit ? heapStats.heap_size_limit : 0;
  const heapUsedBytes = heapStats && heapStats.used_heap_size ? heapStats.used_heap_size : 0;
  const effectiveDocLimit = computeEffectiveDocLimit(heapLimitBytes, documentBudgetBytes);

  if (!isMemoryRuntime) {
    return {allowed: true, reason: 'not_memory_runtime', documentBudgetBytes, effectiveDocLimit};
  }
  if (isView || isLiveViewer) {
    return {allowed: true, reason: 'viewer', documentBudgetBytes, effectiveDocLimit};
  }
  if (!isNewEditableDoc) {
    return {allowed: true, reason: 'existing_doc', documentBudgetBytes, effectiveDocLimit};
  }
  if (openEditableDocs >= effectiveDocLimit) {
    return {allowed: false, reason: 'capacity', documentBudgetBytes, effectiveDocLimit};
  }
  if (heapLimitBytes > 0 && heapUsedBytes + documentBudgetBytes > heapLimitBytes * HEAP_PRESSURE_RATIO) {
    return {allowed: false, reason: 'heap_pressure', documentBudgetBytes, effectiveDocLimit};
  }
  return {allowed: true, reason: 'ok', documentBudgetBytes, effectiveDocLimit};
}

function _isEditableConnection(c) {
  return c && c.user && !c.user.view && !c.isCloseCoAuthoring;
}

/** Count unique docIds with at least one editable connection. */
function countOpenEditableDocs(connections, excludeConn) {
  if (!Array.isArray(connections) || connections.length === 0) return 0;
  const seen = new Set();
  for (const c of connections) {
    if (c === excludeConn) continue;
    if (!_isEditableConnection(c)) continue;
    if (!c.docId) continue;
    seen.add(c.docId);
  }
  return seen.size;
}

function hasOpenEditableDoc(connections, docId, excludeConn) {
  if (!Array.isArray(connections) || connections.length === 0 || !docId) return false;
  for (const c of connections) {
    if (c === excludeConn) continue;
    if (c.docId !== docId) continue;
    if (_isEditableConnection(c)) return true;
  }
  return false;
}

function getHeapStatsSafe() {
  try {
    return v8.getHeapStatistics();
  } catch {
    return {heap_size_limit: 0, used_heap_size: 0};
  }
}

module.exports = {
  computeDocumentBudget,
  computeEffectiveDocLimit,
  checkAdmission,
  countOpenEditableDocs,
  hasOpenEditableDoc,
  getHeapStatsSafe,
  isMemoryRuntime: profile.isMemoryRuntime,
  // Exposed for tests only.
  _internals: {
    DIVISOR,
    MIN_DOCUMENT_BUDGET_BYTES,
    BASE_RESERVE_BYTES,
    HEAP_CAPACITY_RATIO,
    HEAP_PRESSURE_RATIO
  }
};
