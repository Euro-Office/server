/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const config = require('config');
const express = require('express');
const cookieParser = require('cookie-parser');
const commonDefines = require('../../../../../Common/sources/commondefines');
const metrics = require('../../../../../Common/sources/metrics');
const operationContext = require('../../../../../Common/sources/operationContext');
const {validateJWT} = require('../../middleware/auth');
const {createHistory, histogramQuantile, SAMPLE_INTERVAL_MS} = require('./history');

const FETCH_TIMEOUT_MS = 3000;
const docServiceUrl = `http://localhost:${config.get('services.CoAuthoring.server.port')}`;
// /etc/.../default.json is a conffile on deb: a locally modified copy keeps lacking this key after upgrades
const cfgConverterMetricsPort = config.has('FileConverter.converter.metricsPort') ? config.get('FileConverter.converter.metricsPort') : 0;
const cfgSql = config.get('services.CoAuthoring.sql');
const cfgSlowTaskThreshold = config.has('FileConverter.converter.slowTaskThreshold')
  ? config.get('FileConverter.converter.slowTaskThreshold')
  : '10s';

/**
 * Samples of a metric whose labels match, e.g. all converter workers or one of them
 */
function series(list, name, labels = {}, metricName = name) {
  return (list.find(metric => metric.name === name)?.values ?? []).filter(
    v => v.metricName === metricName && Object.entries(labels).every(([key, val]) => v.labels[key] === val)
  );
}

function value(list, name, labels) {
  return series(list, name, labels)[0]?.value ?? null;
}

function sum(list, name, labels, metricName) {
  return series(list, name, labels, metricName).reduce((total, v) => total + v.value, 0);
}

function byLabel(list, name, label) {
  return Object.fromEntries(series(list, name).map(v => [v.labels[label], v.value]));
}

/**
 * Histogram summed over all series (e.g. all converter workers)
 */
function histogram(list, name) {
  const byLe = new Map();
  for (const v of series(list, name, {}, `${name}_bucket`)) {
    const le = Number(v.labels.le.replace('Inf', 'Infinity'));
    byLe.set(le, (byLe.get(le) ?? 0) + v.value);
  }
  const buckets = [...byLe].map(([le, count]) => ({le, count})).sort((a, b) => a.le - b.le);
  return {count: sum(list, name, {}, `${name}_count`), p50: histogramQuantile(buckets, 0.5), p95: histogramQuantile(buckets, 0.95), buckets};
}

function processSummary(name, list, labels = {}) {
  return {
    name,
    cpuSeconds: value(list, 'process_cpu_seconds_total', labels),
    residentMemoryBytes: value(list, 'process_resident_memory_bytes', labels),
    heapUsedBytes: value(list, 'nodejs_heap_size_used_bytes', labels),
    eventLoopLagP99Seconds: value(list, 'nodejs_eventloop_lag_p99_seconds', labels),
    startTimeSeconds: value(list, 'process_start_time_seconds', labels) ?? value(list, 'eo_cluster_process_start_time_seconds', labels)
  };
}

function converterSummary(list) {
  const workers = series(list, 'process_cpu_seconds_total').map(v => v.labels.worker);
  return {
    processes: workers.map(worker => processSummary(worker === 'primary' ? 'converter' : `converter worker ${worker}`, list, {worker})),
    x2t: {
      running: sum(list, 'eo_x2t_running'),
      failed:
        sum(list, 'eo_x2t_duration_seconds', {result: 'error'}, 'eo_x2t_duration_seconds_count') +
        sum(list, 'eo_x2t_duration_seconds', {result: 'timeout'}, 'eo_x2t_duration_seconds_count'),
      durationSeconds: histogram(list, 'eo_x2t_duration_seconds')
    }
  };
}

/**
 * Reduce the collected metrics to what the dashboard shows. Every source except adminPanel is null when unreachable.
 * @param {object} sources
 * @param {Array|null} sources.docService Parsed metrics of docservice
 * @param {Array} sources.adminPanel Parsed metrics of this process
 * @param {Array|null} [sources.converter] Parsed metrics of the converter primary and its workers
 * @param {object|null} [sources.documents] Docservice /internal/documents
 * @param {Array|null} [sources.slowTasks] Slow conversion tasks of the converter, newest first
 */
function summarize({docService, adminPanel, converter = null, documents = null, slowTasks = null}) {
  const converterStats = converter ? converterSummary(converter) : null;
  const summary = {
    docServiceAvailable: Boolean(docService),
    converterAvailable: Boolean(converter),
    server: {
      buildVersion: commonDefines.buildVersion,
      buildNumber: commonDefines.buildNumber,
      slowTaskThreshold: cfgSlowTaskThreshold || '10s',
      database: {type: cfgSql.type, host: cfgSql.dbHost, port: cfgSql.dbPort, name: cfgSql.dbName}
    },
    x2t: converterStats?.x2t ?? null,
    slowTasks,
    processes: [processSummary('adminpanel', adminPanel), ...(converterStats?.processes ?? [])]
  };
  if (!docService) {
    return summary;
  }
  summary.processes.unshift(processSummary('docservice', docService));
  const memory = byLabel(docService, 'eo_host_memory_bytes', 'type');
  const disks = {};
  for (const v of series(docService, 'eo_host_disk_bytes')) {
    disks[v.labels.path] = {...disks[v.labels.path], path: v.labels.path, [v.labels.type]: v.value};
  }
  return {
    ...summary,
    sessions: {
      connections: byLabel(docService, 'eo_connections', 'mode'),
      users: byLabel(docService, 'eo_users', 'mode'),
      documents: value(docService, 'eo_documents_open')
    },
    conversions: {
      ok: value(docService, 'eo_conversion_tasks_completed_total', {result: 'ok'}) ?? 0,
      error: value(docService, 'eo_conversion_tasks_completed_total', {result: 'error'}) ?? 0,
      queue: value(docService, 'eo_conversion_queue_tasks', {queue: 'convert'})
    },
    documents,
    host: {
      load: byLabel(docService, 'eo_host_load_average', 'period'),
      cpus: value(docService, 'eo_host_cpus'),
      memory: {total: memory.total, used: memory.total - memory.available},
      disks: Object.values(disks)
    }
  };
}

async function fetchLocal(url, parse) {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    return response.ok ? await parse(response) : null;
  } catch {
    return null;
  }
}

const parseText = async response => metrics.parsePrometheusText(await response.text());

async function collect() {
  const converterUrl = cfgConverterMetricsPort ? `http://127.0.0.1:${cfgConverterMetricsPort}` : null;
  const [docService, documents, converter, slowTasks, adminPanel] = await Promise.all([
    fetchLocal(`${docServiceUrl}/internal/metrics`, parseText),
    fetchLocal(`${docServiceUrl}/internal/documents`, response => response.json()),
    converterUrl ? fetchLocal(`${converterUrl}/metrics`, parseText) : null,
    converterUrl ? fetchLocal(`${converterUrl}/slow-tasks`, response => response.json()) : null,
    metrics.register.metrics().then(metrics.parsePrometheusText)
  ]);
  return {collectedAt: Date.now(), ...summarize({docService, adminPanel, converter, documents, slowTasks})};
}

const history = createHistory();
let sampling = null;

function sample() {
  // Requests arriving before the first sample share one collection
  sampling ??= collect()
    .then(summary => history.add(summary))
    .catch(err => operationContext.global.logger.warn('stats sampling error: %s', err.message))
    .finally(() => {
      sampling = null;
    });
  return sampling;
}

/**
 * Sample every 30 s, whether or not the dashboard is open, so it has charts right away
 */
function startSampling() {
  sample();
  setInterval(sample, SAMPLE_INTERVAL_MS).unref();
}

const router = express.Router();
router.use(cookieParser());

router.get('/resources', validateJWT, async (req, res) => {
  if (!history.latest()) {
    await sample();
  }
  res.json(history.latest());
});

router.get('/history', validateJWT, (req, res) => {
  res.json({intervalMs: SAMPLE_INTERVAL_MS, samples: history.since(Number(req.query.since) || 0)});
});

module.exports = router;
module.exports.summarize = summarize;
module.exports.startSampling = startSampling;
