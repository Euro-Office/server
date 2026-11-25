/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const operationContext = require('./../../Common/sources/operationContext');

// The editor, live viewer and viewer connection counts this process writes
// under its shard id (DocsCoServer expireDoc). On shutdown its connections
// reconnect to other instances, and its last counts would be added to theirs
// until the shard TTL runs out, so clear() sets them to 0.
function create(shardId) {
  const tenants = new Set();
  return {
    async set(editorStat, ctx, editCount, liveViewCount, viewCount) {
      tenants.add(ctx.tenant);
      await editorStat.setEditorConnectionsCountByShard(ctx, shardId, editCount);
      await editorStat.setLiveViewerConnectionsCountByShard(ctx, shardId, liveViewCount);
      await editorStat.setViewerConnectionsCountByShard(ctx, shardId, viewCount);
    },
    async clear(editorStat) {
      for (const tenant of tenants) {
        const ctx = new operationContext.Context();
        try {
          ctx.init(tenant);
          await this.set(editorStat, ctx, 0, 0, 0);
        } catch (err) {
          ctx.logger.warn('clearing the connection counts of this instance failed: %s', err?.stack || err);
        }
      }
      tenants.clear();
    }
  };
}

module.exports = {create};
