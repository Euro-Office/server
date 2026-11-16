/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const client = require('@prometheus-io/client');
const utils = require('./utils');

const QUEUE_CHECK_TIMEOUT_MS = 2000;

const register = new client.Registry();
client.collectDefaultMetrics({register});

const conversionsCompleted = new client.Counter({
  name: 'eo_conversion_tasks_completed_total',
  help: 'Conversion task results received by this process',
  labelNames: ['result'],
  registers: [register]
});

function connectionMode(conn) {
  if (utils.isLiveViewer(conn)) {
    return 'liveview';
  }
  return conn.isCloseCoAuthoring || conn.user?.view ? 'view' : 'edit';
}

/**
 * Count connections, unique users and open documents per mode
 * @param {Array} connections Active connections of this process
 * @returns {{modes: Object<string, {connections: number, users: number}>, documents: number}}
 */
function countConnections(connections) {
  const users = {edit: new Set(), view: new Set(), liveview: new Set()};
  const modes = {edit: {connections: 0, users: 0}, view: {connections: 0, users: 0}, liveview: {connections: 0, users: 0}};
  const documents = new Set();
  for (const conn of connections) {
    const mode = connectionMode(conn);
    modes[mode].connections++;
    if (conn.user?.idOriginal) {
      users[mode].add(conn.user.idOriginal);
    }
    documents.add(conn.docId);
  }
  for (const mode in modes) {
    modes[mode].users = users[mode].size;
  }
  return {modes, documents: documents.size};
}

const DOCUMENT_SIZES = [
  ['1', 1],
  ['2-5', 5],
  ['6-20', 20],
  ['>20', Infinity]
];

/**
 * Group connections by document. Distribution and totals cover all documents, the list only the largest ones.
 * @param {Array} connections Active connections of this process
 * @param {number} limit Maximum number of documents in the list
 * @returns {{total: number, distribution: Object<string, number>, documents: Array}}
 */
function summarizeDocuments(connections, limit) {
  const byDoc = new Map();
  for (const conn of connections) {
    let doc = byDoc.get(conn.docId);
    if (!doc) {
      doc = {
        fileName: conn.fileName ?? null,
        users: new Set(),
        connections: {edit: 0, view: 0, liveview: 0},
        openedAt: Infinity,
        lastActionAt: 0
      };
      byDoc.set(conn.docId, doc);
    }
    doc.connections[connectionMode(conn)]++;
    if (conn.user?.idOriginal) {
      doc.users.add(conn.user.idOriginal);
    }
    doc.openedAt = Math.min(doc.openedAt, conn.sessionTimeConnect ?? Infinity);
    doc.lastActionAt = Math.max(doc.lastActionAt, conn.sessionTimeLastAction ?? conn.sessionTimeConnect ?? 0);
  }
  const distribution = Object.fromEntries(DOCUMENT_SIZES.map(([label]) => [label, 0]));
  const documents = [...byDoc.values()].map(doc => {
    const users = doc.users.size;
    distribution[DOCUMENT_SIZES.find(([, max]) => users <= max)[0]]++;
    return {...doc, users, openedAt: Number.isFinite(doc.openedAt) ? doc.openedAt : null, lastActionAt: doc.lastActionAt || null};
  });
  // ponytail: full sort per request, a partial top-N selection if documents per node reach 100k
  documents.sort((a, b) => b.users - a.users || b.connections.edit - a.connections.edit);
  return {total: byDoc.size, distribution, documents: documents.slice(0, limit)};
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Register gauges that read docservice state at scrape time
 * @param {Function} getConnections Returns the active connections of this process
 * @param {Function} getQueueLength Resolves to the number of waiting conversion tasks, or null if unknown
 */
function registerDocServiceMetrics(getConnections, getQueueLength) {
  new client.Gauge({
    name: 'eo_connections',
    help: 'Open editor connections on this process',
    labelNames: ['mode'],
    registers: [register],
    collect() {
      const {modes} = countConnections(getConnections());
      for (const mode in modes) {
        this.set({mode}, modes[mode].connections);
      }
    }
  });
  new client.Gauge({
    name: 'eo_users',
    help: 'Unique users with an open connection on this process',
    labelNames: ['mode'],
    registers: [register],
    collect() {
      const {modes} = countConnections(getConnections());
      for (const mode in modes) {
        this.set({mode}, modes[mode].users);
      }
    }
  });
  new client.Gauge({
    name: 'eo_documents_open',
    help: 'Documents with at least one connection on this process',
    registers: [register],
    collect() {
      this.set(countConnections(getConnections()).documents);
    }
  });
  new client.Gauge({
    name: 'eo_conversion_queue_tasks',
    help: 'Conversion tasks waiting in the queue, absent when the queue cannot be read',
    labelNames: ['queue'],
    registers: [register],
    async collect() {
      this.reset();
      try {
        const length = await withTimeout(getQueueLength(), QUEUE_CHECK_TIMEOUT_MS);
        if (typeof length === 'number') {
          this.set({queue: 'convert'}, length);
        }
      } catch {
        // Queue unreachable: leave the gauge empty instead of reporting a stale or false value
      }
    }
  });
}

/**
 * Register host gauges: load, memory and disk space of the given folders
 * @param {string[]} diskPaths Folders to report disk space for
 */
function registerHostMetrics(diskPaths) {
  const paths = [...new Set(diskPaths.filter(Boolean))];
  new client.Gauge({
    name: 'eo_host_load_average',
    help: 'Host load average',
    labelNames: ['period'],
    registers: [register],
    collect() {
      const [load1, load5, load15] = os.loadavg();
      this.set({period: '1m'}, load1);
      this.set({period: '5m'}, load5);
      this.set({period: '15m'}, load15);
    }
  });
  new client.Gauge({
    name: 'eo_host_cpus',
    help: 'CPUs available to this process',
    registers: [register],
    collect() {
      this.set(os.availableParallelism());
    }
  });
  new client.Gauge({
    name: 'eo_host_memory_bytes',
    help: 'Host memory',
    labelNames: ['type'],
    registers: [register],
    collect() {
      this.set({type: 'total'}, os.totalmem());
      this.set({type: 'available'}, os.freemem());
    }
  });
  new client.Gauge({
    name: 'eo_host_disk_bytes',
    help: 'Disk space of the folders the server writes to',
    labelNames: ['path', 'type'],
    registers: [register],
    async collect() {
      this.reset();
      await Promise.all(
        paths.map(async diskPath => {
          try {
            const stat = await fs.promises.statfs(diskPath);
            this.set({path: diskPath, type: 'total'}, stat.blocks * stat.bsize);
            this.set({path: diskPath, type: 'available'}, stat.bavail * stat.bsize);
          } catch {
            // Folder missing or not readable: skip it
          }
        })
      );
    }
  });
}

/**
 * Express handler serving the Prometheus text format
 */
async function handler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  } catch (err) {
    res.status(500).send(err.message);
  }
}

/**
 * process_start_time_seconds is dropped when the cluster registry aggregates, so converter processes report their own
 */
function registerClusterStartTime() {
  new client.Gauge({
    name: 'eo_cluster_process_start_time_seconds',
    help: 'Start time of a converter process, kept per worker in the cluster metrics',
    registers: [register]
  }).set(Math.round(Date.now() / 1000 - process.uptime()));
}

/**
 * Set up a converter worker: label its metrics with the worker id and answer metric requests of the primary
 * @param {string} workerId Cluster worker id
 * @returns {{x2tRunning: client.Gauge, x2tDuration: client.Histogram}}
 */
function registerConverterWorker(workerId) {
  register.setDefaultLabels({worker: workerId});
  registerClusterStartTime();
  client.ClusterRegistry.setRegistries([register]);
  new client.ClusterRegistry();
  return {
    x2tRunning: new client.Gauge({
      name: 'eo_x2t_running',
      help: 'x2t or docbuilder processes running in this converter worker',
      registers: [register]
    }),
    x2tDuration: new client.Histogram({
      name: 'eo_x2t_duration_seconds',
      help: 'Duration of x2t and docbuilder runs',
      labelNames: ['tool', 'result'],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers: [register]
    })
  };
}

/**
 * Serve the metrics of the converter primary and all its workers on 127.0.0.1
 * @param {number} port Port to listen on
 * @returns {http.Server}
 */
function startClusterMetricsServer(port) {
  register.setDefaultLabels({worker: 'primary'});
  registerClusterStartTime();
  client.ClusterRegistry.setRegistries([register]);
  const aggregator = new client.ClusterRegistry();
  return http
    .createServer(async (req, res) => {
      if (req.method !== 'GET' || !req.url.startsWith('/metrics')) {
        res.writeHead(404).end();
        return;
      }
      try {
        const text = await aggregator.clusterMetrics();
        res.writeHead(200, {'Content-Type': aggregator.contentType}).end(text);
      } catch (err) {
        res.writeHead(500).end(err.message);
      }
    })
    .listen(port, '127.0.0.1');
}

/**
 * Parse the Prometheus text format into the shape of Registry.getMetricsAsJSON()
 * @param {string} text Prometheus text exposition
 * @returns {Array<{name: string, type: string, values: Array<{labels: object, value: number, metricName: string}>}>}
 */
function parsePrometheusText(text) {
  const metrics = [];
  let current = null;
  for (const line of text.split('\n')) {
    const type = line.match(/^# TYPE (\S+) (\S+)/);
    if (type) {
      current = {name: type[1], type: type[2], values: []};
      metrics.push(current);
      continue;
    }
    const sample = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)/);
    if (!sample || !current) {
      continue;
    }
    const labels = {};
    for (const [, key, val] of (sample[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[key] = val.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c));
    }
    current.values.push({labels, value: Number(sample[3].replace(/Inf$/, 'Infinity')), metricName: sample[1]});
  }
  return metrics;
}

module.exports = {
  register,
  conversionsCompleted,
  countConnections,
  summarizeDocuments,
  registerDocServiceMetrics,
  registerHostMetrics,
  registerConverterWorker,
  startClusterMetricsServer,
  parsePrometheusText,
  handler
};
