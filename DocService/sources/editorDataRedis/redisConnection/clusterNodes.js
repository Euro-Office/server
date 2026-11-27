/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

const {REDIS_CONNECT_TIMEOUT_MS} = require('../redisConfig');
const {withTimeout, destroyClient, RedisUnavailableError} = require('./helpers');

// How long a command waits for the client of a Cluster node that is not ready
// (connecting or reconnecting) before it fails. node-redis waits without a
// limit, and its client of a node that cannot be reached keeps trying.
const CLUSTER_NODE_READY_TIMEOUT_MS = 2000;

// Limits every wait of a Cluster client for one of its node clients: the slot
// owner of a command, a MOVED/ASK target, a random node. node-redis gets all of
// them from slots.nodeClient. A node that did not become ready in time is
// remembered and its commands fail at once (they would otherwise each wait
// again, one after another on the serialized editor-data lane) until its
// client, which keeps connecting in the background, is ready.
// onUnreachable(address) is called for such a node.
function limitClusterNodeWaits(client, onUnreachable) {
  const slots = client?._slots;
  if (!slots || typeof slots.nodeClient !== 'function') {
    return;
  }
  releaseNodeClientsOfClosedCluster(client, slots);
  const nodeClient = slots.nodeClient.bind(slots);
  const unreachable = new Set();
  const fail = (node, cause) => {
    unreachable.add(node.address);
    onUnreachable(node.address);
    return cause instanceof RedisUnavailableError ? cause : new RedisUnavailableError(cause);
  };
  slots.nodeClient = node => {
    if (!node) {
      return nodeClient(node);
    }
    if (node.client?.isReady) {
      unreachable.delete(node.address);
      return Promise.resolve(node.client);
    }
    if (unreachable.has(node.address)) {
      if (!node.client && !node.connectPromise) {
        // Let node-redis connect it again in the background.
        Promise.resolve()
          .then(() => nodeClient(node))
          .catch(() => {});
      }
      return Promise.reject(fail(node, new Error(`Redis Cluster node ${node.address} is not reachable`)));
    }
    return withTimeout(
      Promise.resolve().then(() => nodeClient(node)),
      CLUSTER_NODE_READY_TIMEOUT_MS,
      `Redis Cluster node ${node.address}`
    ).then(
      ready => {
        if (!ready?.isReady) {
          throw fail(node, new Error(`Redis Cluster node ${node.address} is not ready`));
        }
        return ready;
      },
      error => {
        throw fail(node, error);
      }
    );
  };
}

// Destroys a node client that is no longer used. node-redis cannot destroy a
// client while it creates its socket (a DNS lookup, TCP or TLS handshake in
// progress): the socket is still used when it is ready, the client becomes
// ready although closed, and its ping timer keeps the process alive. A client
// that is not ready is destroyed on its next event instead: 'connect' and
// 'ready' (its socket exists), 'error' and 'reconnecting' (its connect loop
// checks that it is open before it creates the next socket). The timer covers a
// client that emits none of them.
function releaseNodeClient(nodeClient) {
  if (!nodeClient?.isOpen) {
    return;
  }
  if (nodeClient.isReady) {
    destroyClient(nodeClient);
    return;
  }
  const events = ['connect', 'ready', 'error', 'reconnecting'];
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(timer);
    events.forEach(event => nodeClient.removeListener(event, release));
    if (nodeClient.isOpen) {
      destroyClient(nodeClient);
    }
  };
  events.forEach(event => nodeClient.once(event, release));
  const timer = setTimeout(release, REDIS_CONNECT_TIMEOUT_MS + 1000);
  timer.unref?.();
}

function releaseNodeClientsOf(slots) {
  for (const node of slots.nodeByAddress?.values?.() || []) {
    const nodeClient = node.client;
    if (nodeClient) {
      node.client = undefined;
      releaseNodeClient(nodeClient);
    }
  }
}

// node-redis reads the topology without checking afterwards whether the
// cluster client was destroyed meanwhile: a refresh (its own or ours) that
// ends after the release connects node clients for the destroyed client, and
// they would reconnect for ever. They are released as soon as they connect,
// and when such a refresh ends.
function releaseNodeClientsOfClosedCluster(client, slots) {
  const releaseIfClosed = () => {
    if (!slots.isOpen) {
      releaseNodeClientsOf(slots);
    }
  };
  client.on('node-connect', releaseIfClosed);
  client.on('node-ready', releaseIfClosed);
  if (typeof slots.rediscover === 'function') {
    const rediscover = slots.rediscover.bind(slots);
    slots.rediscover = (...args) => Promise.resolve(rediscover(...args)).finally(releaseIfClosed);
  }
}

// Destroys a Cluster client. Its node clients are taken off their nodes first
// and released one by one (see releaseNodeClient); destroying the cluster would
// destroy a connecting one at once. Graceful close() is not used: every
// operation has finished when a client is released (RedisConnection waits for
// them), and close() would wait for the reply of a timed-out command on a
// frozen node.
function releaseClusterClient(client) {
  const slots = client._slots;
  if (slots) {
    releaseNodeClientsOf(slots);
  }
  destroyClient(client);
}

module.exports = {CLUSTER_NODE_READY_TIMEOUT_MS, limitClusterNodeWaits, releaseClusterClient, releaseNodeClient};
