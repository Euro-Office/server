/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import {useRef, useState} from 'react';
import styles from './Charts.module.scss';

// Categorical slots 1-3, checked for colour vision deficiency separation on white
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];

const WIDTH = 440;
const HEIGHT = 170;
const PAD = {top: 10, right: 8, bottom: 22, left: 52};

const formatTime = t => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

function niceMax(value) {
  if (!value || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find(s => s * magnitude >= value);
  return step * magnitude;
}

/**
 * Path through the points, broken where a value is missing (restart, unreachable service)
 */
function linePath(points) {
  let d = '';
  let pen = false;
  for (const [x, y] of points) {
    if (y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/**
 * Line chart over time with a crosshair tooltip
 * @param {object} props
 * @param {Array<{t: number}>} props.samples Samples ordered by time
 * @param {Array<{label: string, value: Function}>} props.series Up to 3 series, value(sample) returns a number or null
 * @param {Function} props.format Formats a value for axis and tooltip
 * @param {string} [props.current] Current value shown next to the title
 */
export function LineChart({title, current, samples, series, format = v => String(v)}) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const values = samples.flatMap(sample => series.map(s => s.value(sample))).filter(v => v !== null && v !== undefined);
  const maxY = niceMax(Math.max(0, ...values));
  const t0 = samples[0]?.t ?? 0;
  const t1 = samples[samples.length - 1]?.t ?? 1;
  const x = t => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (WIDTH - PAD.left - PAD.right);
  const y = v => PAD.top + (1 - v / maxY) * (HEIGHT - PAD.top - PAD.bottom);

  const onMove = event => {
    const rect = svgRef.current.getBoundingClientRect();
    const t = t0 + ((((event.clientX - rect.left) / rect.width) * WIDTH - PAD.left) / (WIDTH - PAD.left - PAD.right)) * (t1 - t0);
    let nearest = 0;
    samples.forEach((sample, i) => {
      if (Math.abs(sample.t - t) < Math.abs(samples[nearest].t - t)) nearest = i;
    });
    setHover(samples.length ? nearest : null);
  };

  const hovered = hover === null ? null : samples[hover];
  return (
    <div className={styles.chart}>
      <div className={styles.header}>
        <span className={styles.title}>
          {title}
          {current && <span className={styles.current}>{current}</span>}
        </span>
        {series.length > 1 && (
          <span className={styles.legend}>
            {series.map((s, i) => (
              <span key={s.label}>
                <i style={{background: SERIES_COLORS[i]}} />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </div>
      {samples.length < 2 ? (
        <div className={styles.empty}>Collecting data, the first points appear within a minute</div>
      ) : (
        <div className={styles.plot}>
          <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role='img' aria-label={title} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {[0, 0.5, 1].map(f => (
              <g key={f}>
                <line className={styles.grid} x1={PAD.left} x2={WIDTH - PAD.right} y1={y(maxY * f)} y2={y(maxY * f)} />
                <text className={styles.axis} x={PAD.left - 6} y={y(maxY * f) + 4} textAnchor='end'>
                  {format(maxY * f)}
                </text>
              </g>
            ))}
            <text className={styles.axis} x={PAD.left} y={HEIGHT - 4}>
              {formatTime(t0)}
            </text>
            <text className={styles.axis} x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor='end'>
              {formatTime(t1)}
            </text>
            {series.map((s, i) => (
              <path
                key={s.label}
                d={linePath(
                  samples.map(sample => {
                    const v = s.value(sample);
                    return [x(sample.t), v === null || v === undefined ? null : y(v)];
                  })
                )}
                fill='none'
                stroke={SERIES_COLORS[i]}
                strokeWidth='2'
                strokeLinejoin='round'
                strokeLinecap='round'
                vectorEffect='non-scaling-stroke'
              />
            ))}
            {hovered && (
              <g>
                <line className={styles.crosshair} x1={x(hovered.t)} x2={x(hovered.t)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
                {series.map((s, i) => {
                  const v = s.value(hovered);
                  return v === null || v === undefined ? null : (
                    <circle key={s.label} cx={x(hovered.t)} cy={y(v)} r='4' fill={SERIES_COLORS[i]} stroke='#fff' strokeWidth='2' />
                  );
                })}
              </g>
            )}
          </svg>
          {hovered && (
            <div
              className={styles.tooltip}
              style={{left: `${(x(hovered.t) / WIDTH) * 100}%`, transform: x(hovered.t) > WIDTH / 2 ? 'translateX(-105%)' : 'translateX(5%)'}}
            >
              <div className={styles.tooltipTime}>{formatTime(hovered.t)}</div>
              {series.map((s, i) => {
                const v = s.value(hovered);
                return (
                  <div key={s.label}>
                    <i style={{background: SERIES_COLORS[i]}} />
                    {s.label}: <b>{v === null || v === undefined ? 'n/a' : format(v)}</b>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
