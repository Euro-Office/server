/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const crypto = require('crypto');
const {EditorCommon} = require('../editorCommon');
const {connectionGroups} = require('../redisConnectionManager');

function EditorStat(database) {
  EditorCommon.call(this, database, connectionGroups.editorStat);
  this.sampleId = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  this.sampleSequence = 0;
}

EditorStat.prototype = Object.create(EditorCommon.prototype);
EditorStat.prototype.constructor = EditorStat;

module.exports = EditorStat;
