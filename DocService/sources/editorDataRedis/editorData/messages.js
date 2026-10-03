/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {ADD_MESSAGE_SCRIPT} = require('../scripts');
const {cfgExpMessage} = require('../editorDataSettings');
const {ttlSeconds, jsonEncode, jsonDecode} = require('../redisValueCodec');

module.exports = function attachMessages(EditorData) {
  EditorData.prototype.addMessage = async function (ctx, docId, msg) {
    const ttl = ttlSeconds(ctx, 'services.CoAuthoring.expire.message', cfgExpMessage);
    await this._eval(ADD_MESSAGE_SCRIPT, [this._docKeys(ctx, docId).messages], [jsonEncode(msg), String(ttl)]);
  };

  EditorData.prototype.removeMessages = async function (ctx, docId) {
    await this._command(['DEL', this._docKeys(ctx, docId).messages]);
  };

  EditorData.prototype.getMessages = async function (ctx, docId) {
    const result = await this._command(['LRANGE', this._docKeys(ctx, docId).messages, '0', '-1']);
    return (result || []).map(value => jsonDecode(value, null));
  };
};
