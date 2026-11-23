/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

const SAMPLE_INTERVAL_MS = 30 * 1000;
const HISTORY_CAPACITY = (6 * 3600 * 1000) / SAMPLE_INTERVAL_MS;

/**
 * Estimate a quantile from cumulative histogram buckets, like Prometheus histogram_quantile
 * @param {Array<{le: number, count: number}>} buckets Sorted by le, cumulative counts
 * @param {number} q Quantile between 0 and 1
 * @returns {number|null}
 */
function histogramQuantile(buckets, q) {
  const total = buckets.length ? buckets[buckets.length - 1].count : 0;
  if (!total) {
    return null;
  }
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const {le, count} of buckets) {
    if (count >= rank) {
      return le === Infinity ? prevLe : prevLe + ((le - prevLe) * (rank - prevCount)) / (count - prevCount || 1);
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

/**
 * Change of a counter per second, null when it was reset in between (process restart)
 */
function ratePerSecond(current, previous, seconds) {
  return current == null || previous == null || current < previous ? null : (current - previous) / seconds;
}

/**
 * Add the CPU use since the previous summary to each process (share of one CPU, null when unknown)
 */
function withCpu(summary, previous) {
  const seconds = previous ? (summary.collectedAt - previous.collectedAt) / 1000 : null;
  const processes = summary.processes.map(proc => {
    const before = previous?.processes.find(p => p.name === proc.name && p.startTimeSeconds === proc.startTimeSeconds);
    return {...proc, cpu: seconds && before ? ratePerSecond(proc.cpuSeconds, before.cpuSeconds, seconds) : null};
  });
  return {...summary, processes};
}

function sumOrNull(values) {
  return values.length && values.every(v => v != null) ? values.reduce((a, b) => a + b, 0) : null;
}

/**
 * Quantile of the x2t runs between two summaries
 */
function intervalQuantile(summary, previous, q) {
  const buckets = summary.x2t?.durationSeconds.buckets;
  const before = previous?.x2t?.durationSeconds.buckets;
  if (!buckets?.length || !before?.length) {
    return null;
  }
  const delta = buckets.map(({le, count}) => ({le, count: count - (before.find(b => b.le === le)?.count ?? 0)}));
  return delta.some(b => b.count < 0) ? null : histogramQuantile(delta, q);
}

/**
 * Reduce a summary (with CPU, see withCpu) to one chart sample. Rates cover the time since the previous summary.
 */
function toSample(summary, previous) {
  const seconds = previous ? (summary.collectedAt - previous.collectedAt) / 1000 : null;
  const perMinute = key => {
    const rate =
      seconds && previous.conversions && summary.conversions ? ratePerSecond(summary.conversions[key], previous.conversions[key], seconds) : null;
    return rate === null ? null : rate * 60;
  };
  const proc = name => summary.processes.find(p => p.name === name);
  const converter = summary.processes.filter(p => p.name.startsWith('converter'));
  return {
    t: summary.collectedAt,
    connections: summary.sessions?.connections ?? null,
    conversionsOk: perMinute('ok'),
    conversionsFailed: perMinute('error'),
    x2tP50: intervalQuantile(summary, previous, 0.5),
    x2tP95: intervalQuantile(summary, previous, 0.95),
    cpu: {docservice: proc('docservice')?.cpu ?? null, converter: sumOrNull(converter.map(p => p.cpu)), adminpanel: proc('adminpanel')?.cpu ?? null},
    memory: {
      host: summary.host?.memory.used ?? null,
      docservice: proc('docservice')?.residentMemoryBytes ?? null,
      converter: sumOrNull(converter.map(p => p.residentMemoryBytes))
    }
  };
}

/**
 * Latest summary plus a ring buffer of chart samples, 6 hours at the sampling interval
 * @param {number} capacity Maximum number of samples
 */
function createHistory(capacity = HISTORY_CAPACITY) {
  const samples = [];
  let latest = null;
  return {
    add(summary) {
      const current = withCpu(summary, latest);
      samples.push(toSample(current, latest));
      if (samples.length > capacity) {
        samples.splice(0, samples.length - capacity);
      }
      latest = current;
    },
    latest: () => latest,
    since: t => samples.filter(sample => sample.t > t)
  };
}

module.exports = {createHistory, histogramQuantile, SAMPLE_INTERVAL_MS};
