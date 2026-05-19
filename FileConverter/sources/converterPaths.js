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

const path = require('path');

// In pkg builds __dirname resolves inside the virtual snapshot, which cannot
// hold native binaries.  Use the real executable location instead.
// Both DocService (docservice) and FileConverter (converter) pkg targets sit
// one level below the install root, so ../FileConverter always lands correctly.
const FC_DEFAULT_BASE = process.pkg ? path.resolve(path.dirname(process.execPath), '..', 'FileConverter') : path.resolve(__dirname, '..');

/**
 * Resolve a FileConverter path config value to an absolute path.
 *
 * - Absolute paths are returned unchanged.
 * - Falsy values or the literal string 'null' (the default.json sentinel)
 *   return an empty string.
 * - Relative paths are resolved against FC_DEFAULT_BASE (FileConverter/).
 *
 * Do NOT use this for FileConverter.converter.errorfiles: that is a storage
 * route/prefix, not a local filesystem path.
 *
 * @param {string|null|undefined} value - raw config value
 * @returns {string} absolute path, or '' if value is absent/null sentinel
 */
function resolveConverterPath(value) {
  if (!value || value === 'null') return '';
  if (path.isAbsolute(value)) return value;
  return path.resolve(FC_DEFAULT_BASE, value);
}

module.exports = {resolveConverterPath, FC_DEFAULT_BASE};
