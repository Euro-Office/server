/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {REDIS_RESP_VERSION, cfgRedisOptionsCluster, cloneConfig, normalizeCommandOptions} = require('./base');
const {normalizeNodeOptions} = require('./nodeOptions');

// A node that stops answering without closing its connection (a frozen or
// partitioned master) is never noticed by node-redis: its commands wait for
// the adapter's command timeout, which then has to drop the whole cluster
// client. With an idle-socket timeout (kept from firing on a healthy idle
// socket by the ping interval) node-redis closes that one node's socket
// itself once nothing was sent to it for that long (the serialized
// editor-data lane sends nothing new while it waits; a lane that keeps
// writing to the node still ends at the command timeout), and a reconnect
// strategy that keeps retrying lets its cluster client refresh the topology
// on the reconnect attempts (a promoted replica takes the slots). The default
// strategy gives up after a socket timeout and would leave a closed client on
// the node.
// The idle timeout also runs while a node computes a reply, so it must stay
// above the server's busy-reply-threshold (5 s by default; a node answers the
// queued PING with BUSY then) and above fork or fsync stalls: a longer stall
// rejects the commands in flight on that node. Configurable through
// optionsCluster.defaults.socket.socketTimeout.
const CLUSTER_NODE_SOCKET_TIMEOUT_MS = 10000;
const CLUSTER_NODE_PING_INTERVAL_MS = 3000;
function clusterNodeReconnectStrategy(retries) {
  return Math.min(2 ** retries * 50, 2000) + Math.floor(Math.random() * 100);
}

function normalizeClusterOptions(source) {
  const options = cloneConfig(source) || {};
  options.defaults = normalizeNodeOptions(options.defaults || {}, undefined, false, false);
  options.defaults.disableOfflineQueue = true;
  options.defaults.socket = options.defaults.socket || {};
  options.defaults.socket.socketTimeout ??= CLUSTER_NODE_SOCKET_TIMEOUT_MS;
  options.defaults.socket.reconnectStrategy ??= clusterNodeReconnectStrategy;
  options.defaults.pingInterval ??= CLUSTER_NODE_PING_INTERVAL_MS;
  delete options.defaults.RESP;
  delete options.defaults.database;
  delete options.defaults.commandOptions;
  options.commandOptions = normalizeCommandOptions(options.commandOptions);
  options.RESP = REDIS_RESP_VERSION;
  return options;
}

function hasNodeCluster() {
  const options = cloneConfig(cfgRedisOptionsCluster) || {};
  return Array.isArray(options.rootNodes) && options.rootNodes.length > 0;
}

module.exports = {normalizeClusterOptions, hasNodeCluster, clusterNodeReconnectStrategy};
