'use client';
// Dependency-free SVG charts (gauge, sparkline, bars) — keeps the gov bundle free of
// runtime chart libraries while still delivering polished dashboards.
import * as React from 'react';

export function ScoreGauge({ score, size = 160 }: { score: number; size?: number }) {
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color =
    score >= 90 ? 'hsl(var(--success))' : score >= 70 ? 'hsl(var(--brand))' : score >= 60 ? 'hsl(var(--warning))' : 'hsl(var(--danger))';
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={12} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={12}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1)' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-4xl font-semibold tabular-nums text-fg">{Math.round(score)}</span>
        <span className="text-xs font-medium text-muted">Grade {grade}</span>
      </div>
    </div>
  );
}

export function Sparkline({ data, width = 220, height = 56, color = 'hsl(var(--brand))' }: { data: number[]; width?: number; height?: number; color?: string }) {
  if (data.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((d, i) => `${i * step},${height - ((d - min) / span) * (height - 8) - 4}`);
  const area = `0,${height} ${pts.join(' ')} ${width},${height}`;
  return (
    <svg width={width} height={height}>
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#spark)" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Donut({
  segments,
  size = 180,
  centerLabel,
  centerValue,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  size?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-5">
      <div className="relative grid place-items-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--surface-2))" strokeWidth={16} />
          {segments.map((s, i) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={16}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute flex flex-col items-center">
          {centerValue && <span className="text-2xl font-semibold tabular-nums text-fg">{centerValue}</span>}
          {centerLabel && <span className="text-[11px] text-muted">{centerLabel}</span>}
        </div>
      </div>
      <div className="space-y-1.5">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            <span className="text-muted">{s.label}</span>
            <span className="ml-auto tabular-nums text-fg">{s.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Scatter({
  points,
  width = 340,
  height = 200,
  xLabel,
  yLabel,
}: {
  points: Array<{ x: number; y: number; size?: number }>;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
}) {
  if (!points.length) return <div style={{ width, height }} className="grid place-items-center text-xs text-muted">No data</div>;
  const pad = 28;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs) || 1;
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys) || 1;
  const sx = (x: number) => pad + ((x - xMin) / (xMax - xMin || 1)) * (width - pad * 1.5);
  const sy = (y: number) => height - pad - ((y - yMin) / (yMax - yMin || 1)) * (height - pad * 1.5);
  const maxSize = Math.max(...points.map((p) => p.size ?? 1), 1);
  return (
    <svg width={width} height={height}>
      <line x1={pad} y1={height - pad} x2={width - pad / 2} y2={height - pad} stroke="hsl(var(--border))" />
      <line x1={pad} y1={pad / 2} x2={pad} y2={height - pad} stroke="hsl(var(--border))" />
      {points.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={4 + ((p.size ?? 1) / maxSize) * 8} fill="hsl(var(--brand))" fillOpacity={0.55} stroke="hsl(var(--brand))" />
      ))}
      {xLabel && <text x={width / 2} y={height - 4} textAnchor="middle" className="fill-muted text-[10px]">{xLabel}</text>}
      {yLabel && <text x={10} y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`} className="fill-muted text-[10px]">{yLabel}</text>}
    </svg>
  );
}

export function MiniBars({ items }: { items: Array<{ label: string; value: number; color?: string }> }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-xs text-muted">{i.label}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{ width: `${(i.value / max) * 100}%`, background: i.color ?? 'hsl(var(--brand))', transition: 'width 0.6s' }}
            />
          </div>
          <span className="w-8 text-right text-xs tabular-nums text-fg">{i.value}</span>
        </div>
      ))}
    </div>
  );
}
