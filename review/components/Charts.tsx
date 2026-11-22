'use client';
import type { CalibrationRow } from '../lib/types';

/**
 * Small dependency-free SVG charts. Each takes plain arrays and draws into a fixed viewBox that scales
 * with its container.
 */

const W = 640;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

function fmt(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export interface BarSeries {
  label: string;
  values: number[];
  alt?: boolean;
}

/** Grouped bars over categorical labels (e.g. days). */
export function BarChart({ labels, series, height = 200, format = fmt }: { labels: string[]; series: BarSeries[]; height?: number; format?: (v: number) => string }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const group = innerW / Math.max(1, labels.length);
  const barW = Math.max(2, (group * 0.7) / Math.max(1, series.length));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const every = Math.ceil(labels.length / 10);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={series.map((s) => s.label).join(', ')}>
        {ticks(max).map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => (
          <g key={l}>
            {series.map((s, j) => {
              const v = s.values[i] ?? 0;
              const x = PAD.left + i * group + (group - barW * series.length) / 2 + j * barW;
              return (
                <rect key={s.label} className={`bar ${s.alt ? 'alt' : ''}`} x={x} y={y(v)} width={barW - 1} height={Math.max(0, PAD.top + innerH - y(v))}>
                  <title>{`${l} · ${s.label}: ${format(v)}`}</title>
                </rect>
              );
            })}
            {i % every === 0 && (
              <text x={PAD.left + i * group + group / 2} y={height - 8} textAnchor="middle">
                {l}
              </text>
            )}
          </g>
        ))}
        <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} />
      </svg>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.label}>
              <i style={{ background: s.alt ? 'var(--ok)' : 'var(--accent)' }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Precision by auto-approve threshold, with the 95% interval as a band, the target as a dashed line
 * and the current threshold marked. Coverage (how much would auto-approve) is drawn in green.
 */
export function CalibrationChart({ rows, target, current, height = 240 }: { rows: CalibrationRow[]; target: number; current: number; height?: number }) {
  const pts = rows.filter((r) => r.precision !== null);
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  if (!rows.length) return <p className="muted">No data.</p>;
  const minT = rows[0].threshold;
  const maxT = rows[rows.length - 1].threshold;
  const x = (t: number) => PAD.left + ((t - minT) / Math.max(1e-9, maxT - minT)) * innerW;
  const y = (p: number) => PAD.top + innerH - p * innerH;
  const line = (vals: [number, number][]) => vals.map(([a, b], i) => `${i ? 'L' : 'M'}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(' ');
  const band =
    pts.length > 1
      ? `${line(pts.map((r) => [r.threshold, r.ci!.high]))} ${pts
          .slice()
          .reverse()
          .map((r) => `L${x(r.threshold).toFixed(1)},${y(r.ci!.low).toFixed(1)}`)
          .join(' ')} Z`
      : '';
  const coverage = rows.filter((r) => r.coverage !== null);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Precision by threshold">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {band && <path className="band" d={band} />}
        {pts.length > 1 && <path className="line" d={line(pts.map((r) => [r.threshold, r.precision!]))} />}
        {coverage.length > 1 && <path className="line" style={{ stroke: 'var(--ok)', strokeDasharray: '2 2' }} d={line(coverage.map((r) => [r.threshold, r.coverage!]))} />}
        {pts.map((r) => (
          <circle key={r.threshold} cx={x(r.threshold)} cy={y(r.precision!)} r={3} fill="var(--accent)">
            <title>{`≥ ${r.threshold}: ${(r.precision! * 100).toFixed(1)}% of ${r.n} (CI ${(r.ci!.low * 100).toFixed(0)}–${(r.ci!.high * 100).toFixed(0)}%)`}</title>
          </circle>
        ))}
        <line className="marker" x1={PAD.left} x2={W - PAD.right} y1={y(target)} y2={y(target)} />
        {current >= minT && current <= maxT && <line className="axis" strokeDasharray="1 3" x1={x(current)} x2={x(current)} y1={PAD.top} y2={PAD.top + innerH} />}
        {rows
          .filter((_, i) => i % Math.ceil(rows.length / 8) === 0)
          .map((r) => (
            <text key={r.threshold} x={x(r.threshold)} y={height - 8} textAnchor="middle">
              {r.threshold.toFixed(2)}
            </text>
          ))}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--accent)' }} />
          Precision (95% band)
        </span>
        <span>
          <i style={{ background: 'var(--ok)' }} />
          Share that would auto-approve
        </span>
        <span>
          <i style={{ background: 'var(--bad)' }} />
          Target {Math.round(target * 100)}%
        </span>
      </div>
    </div>
  );
}

/** Tiny inline trend line for stat cards. */
export function Sparkline({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg className="chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path className="line" d={d} style={{ strokeWidth: 1.5 }} />
    </svg>
  );
}

/** Horizontal bars for ranked lists (finding codes, categories). */
export function HBars({ rows, format = fmt }: { rows: { label: string; value: number; highlight?: number }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div className="spread small">
            <span className="mono">{r.label}</span>
            <span>{format(r.value)}</span>
          </div>
          <div className="meter">
            <span className="info" style={{ width: `${((r.value - (r.highlight ?? 0)) / max) * 100}%` }} />
            {r.highlight ? <span className="bad" style={{ width: `${(r.highlight / max) * 100}%` }} /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
