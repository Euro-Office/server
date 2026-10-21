/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const EditorStat = require('./editorStat/base');
const attachUniqueUsers = require('./editorStat/uniqueUsers');
const attachMonthlyUsers = require('./editorStat/monthlyUsers');
const attachConnections = require('./editorStat/connections');
const attachHousekeeping = require('./editorStat/housekeeping');

attachUniqueUsers(EditorStat);
attachMonthlyUsers(EditorStat);
attachConnections(EditorStat);
attachHousekeeping(EditorStat);

module.exports = EditorStat;
