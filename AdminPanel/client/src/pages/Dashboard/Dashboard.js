/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import {useEffect, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import PageHeader from '../../components/PageHeader/PageHeader';
import PageDescription from '../../components/PageDescription/PageDescription';
import Section from '../../components/Section/Section';
import {fetchResourceStats, fetchStatsHistory} from '../../api';
import {LineChart} from './Charts';
import styles from './Dashboard.module.scss';

// The admin panel samples every 30 s, refreshing more often shows nothing new
const REFRESH_INTERVAL_MS = 30000;
const HISTORY_MS = 6 * 3600 * 1000;
const LONG_OPEN_MS = 8 * 3600 * 1000;
const LONG_IDLE_MS = 3600 * 1000;
const MODES = [
  ['edit', 'Editing'],
  ['view', 'Viewing'],
  ['liveview', 'Live viewing']
];

const formatBytes = bytes => {
  if (bytes == null) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const formatSeconds = seconds => (seconds == null ? 'n/a' : seconds < 1 ? `${(seconds * 1000).toFixed(0)} ms` : `${seconds.toFixed(1)} s`);
const formatPercent = ratio => (ratio == null || Number.isNaN(ratio) ? 'n/a' : `${(ratio * 100).toFixed(0)}%`);
const formatRate = v => (v == null ? 'n/a' : v < 10 ? v.toFixed(1) : v.toFixed(0));
const formatDuration = ms => {
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`;
};
const formatUptime = startTimeSeconds => (startTimeSeconds ? formatDuration(Date.now() - startTimeSeconds * 1000) : 'n/a');

const DOCUMENT_SORTS = {
  users: ['Users', (a, b) => b.users - a.users],
  open: ['Open longest', (a, b) => (a.openedAt ?? Infinity) - (b.openedAt ?? Infinity)],
  idle: ['Idle longest', (a, b) => (a.lastActionAt ?? Infinity) - (b.lastActionAt ?? Infinity)]
};

function Stat({label, value, hint}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
      {hint && <div className={styles.statHint}>{hint}</div>}
    </div>
  );
}

function Meter({label, used, total}) {
  const ratio = total ? used / total : null;
  return (
    <div className={styles.meter}>
      <div className={styles.meterHeader}>
        <span>{label}</span>
        <span>
          {formatBytes(used)} of {formatBytes(total)} ({formatPercent(ratio)})
        </span>
      </div>
      <div className={styles.meterTrack}>
        <div className={`${styles.meterFill} ${ratio > 0.9 ? styles.critical : ''}`} style={{width: `${Math.min(100, (ratio || 0) * 100)}%`}} />
      </div>
    </div>
  );
}

function Documents({documents, now}) {
  const [sortBy, setSortBy] = useState('users');
  const sorted = [...documents.documents].sort(DOCUMENT_SORTS[sortBy][1]);
  const truncated = documents.total > documents.documents.length;
  return (
    <Section title='Documents' description={truncated ? `The ${documents.documents.length} documents with most users` : null}>
      <div className={styles.stats}>
        {Object.entries(documents.distribution).map(([size, count]) => (
          <Stat key={size} label={`${size} ${size === '1' ? 'user' : 'users'}`} value={count} />
        ))}
      </div>
      {sorted.length > 0 && (
        <>
          <div className={styles.sortBar}>
            Sort by
            {Object.entries(DOCUMENT_SORTS).map(([key, [label]]) => (
              <button key={key} type='button' className={sortBy === key ? styles.sortActive : ''} onClick={() => setSortBy(key)}>
                {label}
              </button>
            ))}
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>File</th>
                <th>Users</th>
                <th>Editing / viewing / live</th>
                <th>Open for</th>
                <th>Idle for</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((doc, i) => {
                const openFor = doc.openedAt ? now - doc.openedAt : null;
                const idleFor = doc.lastActionAt ? now - doc.lastActionAt : null;
                return (
                  <tr key={i}>
                    <td>{doc.fileName || 'n/a'}</td>
                    <td>{doc.users}</td>
                    <td>
                      {doc.connections.edit} / {doc.connections.view} / {doc.connections.liveview}
                    </td>
                    <td className={openFor > LONG_OPEN_MS ? styles.flagged : ''}>{openFor === null ? 'n/a' : formatDuration(openFor)}</td>
                    <td className={idleFor > LONG_IDLE_MS ? styles.flagged : ''}>{idleFor === null ? 'n/a' : formatDuration(idleFor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}

const formatMs = value => (value == null ? '-' : formatSeconds(value / 1000));

function SlowConversions({tasks, threshold}) {
  return (
    <Section
      title='Slow conversions'
      description={`The latest ${tasks.length} conversions that took longer than ${threshold}, including the queue wait`}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Finished</th>
            <th>File</th>
            <th>Conversion</th>
            <th>Queue wait</th>
            <th>Download</th>
            <th>Convert</th>
            <th>Total with queue</th>
            <th>Size</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, i) => (
            <tr key={i}>
              <td className={styles.nowrap}>
                {new Date(task.finishedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </td>
              <td>{task.fileName || 'n/a'}</td>
              <td>
                {task.command} {task.formatFrom || '?'} → {task.formatTo || '?'}
              </td>
              <td className={styles.nowrap}>{formatMs(task.queueWait)}</td>
              <td className={styles.nowrap}>{formatMs(task.download)}</td>
              <td className={styles.nowrap}>{formatMs(task.convert)}</td>
              <td className={styles.nowrap}>{formatMs((task.queueWait ?? 0) + task.total)}</td>
              <td className={styles.nowrap}>{typeof task.size === 'number' ? formatBytes(task.size) : '-'}</td>
              <td>{task.status === 0 ? 'ok' : task.status == null ? '-' : `error ${task.status}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/**
 * Chart samples kept by the admin panel server, fetched incrementally
 */
function useHistory() {
  const [samples, setSamples] = useState([]);
  useEffect(() => {
    let since = 0;
    let stopped = false;
    const load = async () => {
      try {
        const {samples: fresh} = await fetchStatsHistory(since);
        if (stopped || !fresh.length) return;
        since = fresh[fresh.length - 1].t;
        setSamples(previous => [...previous, ...fresh].filter(sample => sample.t > since - HISTORY_MS));
      } catch {
        // Keep the samples we have, the next refresh retries
      }
    };
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);
  return samples;
}

export default function Dashboard() {
  const {data, error, isLoading} = useQuery({
    queryKey: ['resourceStats'],
    queryFn: fetchResourceStats,
    refetchInterval: REFRESH_INTERVAL_MS
  });
  const samples = useHistory();

  if (isLoading) return <div className={styles.dashboard}>Loading...</div>;
  if (error) return <div className={styles.dashboard}>Error: {error.message}</div>;

  const {server, sessions, conversions, x2t, documents, slowTasks, host, processes} = data;
  const latest = samples[samples.length - 1];
  const cpuOf = name => processes.find(p => p.name === name)?.cpu;
  return (
    <div className={styles.dashboard}>
      <PageHeader>Dashboard</PageHeader>
      <PageDescription>
        This server node, refreshed every {REFRESH_INTERVAL_MS / 1000} seconds. Charts show the last 6 hours kept by the admin panel. Scrape
        /internal/metrics with Prometheus for longer history and all nodes of a cluster.
      </PageDescription>

      {!data.docServiceAvailable && <div className={styles.warning}>DocService is not reachable. Only admin panel values are shown.</div>}
      {!data.converterAvailable && (
        <div className={styles.warning}>Converter metrics are not reachable. Check FileConverter.converter.metricsPort.</div>
      )}

      <div className={styles.tiles}>
        <Stat label='Open documents' value={sessions?.documents ?? 'n/a'} />
        <Stat label='Waiting in queue' value={conversions?.queue ?? 'n/a'} />
        <Stat label='x2t running' value={x2t?.running ?? 'n/a'} hint={x2t ? `${x2t.failed} failed or timed out` : null} />
      </div>

      <div className={styles.grid}>
        <LineChart
          title='Connections'
          current={sessions && `${sessions.connections.edit} editing, ${sessions.connections.view + sessions.connections.liveview} viewing`}
          samples={samples}
          series={MODES.map(([mode, label]) => ({label, value: s => s.connections?.[mode] ?? null}))}
        />
        <LineChart
          title='Conversions per minute'
          current={latest && `${formatRate(latest.conversionsOk)} finished, ${formatRate(latest.conversionsFailed)} failed`}
          samples={samples}
          format={formatRate}
          series={[
            {label: 'Finished', value: s => s.conversionsOk},
            {label: 'Failed', value: s => s.conversionsFailed}
          ]}
        />
        <LineChart
          title='CPU'
          current={`DocService ${formatPercent(cpuOf('docservice'))}, converter ${formatPercent(latest?.cpu.converter)}`}
          samples={samples}
          format={formatPercent}
          series={[
            {label: 'DocService', value: s => s.cpu.docservice},
            {label: 'Converter', value: s => s.cpu.converter},
            {label: 'Admin panel', value: s => s.cpu.adminpanel}
          ]}
        />
        <LineChart
          title='Memory'
          current={host && `${formatBytes(host.memory.used)} of ${formatBytes(host.memory.total)} used`}
          samples={samples}
          format={formatBytes}
          series={[
            {label: 'Host used', value: s => s.memory.host},
            {label: 'Converter', value: s => s.memory.converter},
            {label: 'DocService', value: s => s.memory.docservice}
          ]}
        />
        <LineChart
          title='x2t duration'
          current={x2t && `median ${formatSeconds(x2t.durationSeconds.p50)}, p95 ${formatSeconds(x2t.durationSeconds.p95)}`}
          samples={samples}
          format={formatSeconds}
          series={[
            {label: 'Median', value: s => s.x2tP50},
            {label: 'p95', value: s => s.x2tP95}
          ]}
        />
        <Section title='Server'>
          <div className={styles.stats}>
            <Stat label='Version' value={server.buildVersion} hint={`Build ${server.buildNumber}`} />
            <Stat label='Database' value={server.database.type} hint={`${server.database.name} on ${server.database.host}:${server.database.port}`} />
            {host && (
              <Stat label='Load (1 / 15 min)' value={`${host.load['1m'].toFixed(2)} / ${host.load['15m'].toFixed(2)}`} hint={`${host.cpus} CPUs`} />
            )}
          </div>
          {host?.disks.map(disk => (
            <Meter key={disk.path} label={`Disk ${disk.path}`} used={disk.total - disk.available} total={disk.total} />
          ))}
        </Section>
      </div>

      <div className={styles.wideGrid}>
        {documents && <Documents documents={documents} now={data.collectedAt} />}
        <Section title='Processes'>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Service</th>
                <th>CPU</th>
                <th>Memory (RSS)</th>
                <th>Heap used</th>
                <th>Event loop lag (p99)</th>
                <th>Uptime</th>
              </tr>
            </thead>
            <tbody>
              {processes.map(proc => (
                <tr key={proc.name}>
                  <td>{proc.name}</td>
                  <td>{formatPercent(proc.cpu)}</td>
                  <td>{formatBytes(proc.residentMemoryBytes)}</td>
                  <td>{formatBytes(proc.heapUsedBytes)}</td>
                  <td>{formatSeconds(proc.eventLoopLagP99Seconds)}</td>
                  <td>{formatUptime(proc.startTimeSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      {slowTasks?.length > 0 && (
        <div className={styles.fullWidth}>
          <SlowConversions tasks={slowTasks} threshold={server.slowTaskThreshold} />
        </div>
      )}
    </div>
  );
}
