'use client';
// The 5x5 likelihood x impact matrix in its three uses — portfolio heat map (counts, click to
// filter), assessment picker (choose a cell), and score trail (inherent -> residual -> target on
// one grid). One cell renderer, so a colour can never mean one thing in a view and another in a form.
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/primitives';
import {
  IMPACT_LABELS, LIKELIHOOD_LABELS, RATING_FILL, RATING_LABEL, RATING_TONE, ratingFor, type RiskRating,
} from '@/lib/risks';

const LEVELS = [5, 4, 3, 2, 1] as const; // likelihood rows, top = almost certain
const IMPACTS = [1, 2, 3, 4, 5] as const;

export function RatingBadge({ rating, score }: { rating: RiskRating; score?: number }) {
  return (
    <Badge tone={RATING_TONE[rating]} className="whitespace-nowrap">
      <span className="h-2 w-2 rounded-full" style={{ background: RATING_FILL[rating] }} aria-hidden />
      {RATING_LABEL[rating]}{score !== undefined && <span className="tabular-nums opacity-80">· {score}</span>}
    </Badge>
  );
}

/** A compact L×I = score chip, coloured by band. */
export function ScoreChip({ l, i, label }: { l: number | null; i: number | null; label?: string }) {
  if (!l || !i) return <span className="text-xs text-muted">—</span>;
  const s = l * i;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs tabular-nums text-fg"
      style={{ background: RATING_FILL[ratingFor(s)] }}
      title={`${label ? label + ': ' : ''}likelihood ${l} × impact ${i} = ${s} (${RATING_LABEL[ratingFor(s)]})`}
    >
      <span className="font-semibold">{s}</span>
      <span className="text-[10px] opacity-70">{l}×{i}</span>
    </span>
  );
}

function Axes({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div className="flex gap-2">
      <div className={cn('flex flex-col justify-around text-right text-muted', compact ? 'text-[9px]' : 'text-[10px]')} aria-hidden>
        {LEVELS.map((l) => (
          <div key={l} className="flex h-full items-center justify-end leading-tight">
            {compact ? l : <span className="max-w-[72px]">{LIKELIHOOD_LABELS[l - 1]}</span>}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {children}
        <div className={cn('mt-1 grid grid-cols-5 gap-1 text-center text-muted', compact ? 'text-[9px]' : 'text-[10px]')} aria-hidden>
          {IMPACTS.map((i) => <div key={i} className="truncate">{compact ? i : IMPACT_LABELS[i - 1]}</div>)}
        </div>
        {!compact && <div className="mt-0.5 text-center text-[10px] uppercase tracking-widest text-muted/70">Impact →</div>}
      </div>
    </div>
  );
}

/**
 * Heat map of counts. `appetite` draws a dashed outline on every cell above the organization's
 * appetite, so "where is the line" is answered on the map itself rather than in a legend.
 */
export function HeatMap({
  grid, selected, onSelect, appetite, tolerance,
}: {
  grid: number[][];
  selected?: { l: number; i: number } | null;
  onSelect?: (cell: { l: number; i: number } | null) => void;
  appetite?: number;
  tolerance?: number;
}) {
  return (
    <Axes>
      <div className="grid grid-cols-5 gap-1" role="grid" aria-label="Risk heat map: likelihood by impact">
        {LEVELS.map((l) =>
          IMPACTS.map((i) => {
            const n = grid[l - 1][i - 1];
            const s = l * i;
            const r = ratingFor(s);
            const isSel = selected?.l === l && selected?.i === i;
            const above = appetite !== undefined && s > appetite;
            const overTol = tolerance !== undefined && s > tolerance;
            return (
              <button
                key={`${l}-${i}`}
                type="button"
                role="gridcell"
                aria-selected={isSel}
                aria-label={`Likelihood ${LIKELIHOOD_LABELS[l - 1]}, impact ${IMPACT_LABELS[i - 1]}, score ${s}: ${n} risk${n === 1 ? '' : 's'}${overTol ? ', above tolerance' : above ? ', above appetite' : ''}`}
                onClick={() => onSelect?.(isSel ? null : { l, i })}
                disabled={!onSelect}
                className={cn(
                  'relative flex aspect-[4/3] items-center justify-center rounded-md text-sm font-semibold tabular-nums transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
                  onSelect && 'hover:brightness-110 hover:ring-1 hover:ring-fg/20',
                  isSel && 'ring-2 ring-fg',
                  n === 0 && 'opacity-55',
                )}
                style={{
                  background: RATING_FILL[r],
                  outline: above ? `1.5px dashed hsl(var(--${overTol ? 'danger' : 'warning'}))` : undefined,
                  outlineOffset: above ? '-4px' : undefined,
                }}
              >
                <span className={cn(n === 0 ? 'text-fg/40' : 'text-fg')}>{n || '·'}</span>
              </button>
            );
          }),
        )}
      </div>
    </Axes>
  );
}

/** Pick a likelihood and impact by clicking a cell. A radio group to assistive technology. */
export function MatrixPicker({
  label, l, i, onChange, compact,
}: {
  label: string;
  l: number | null;
  i: number | null;
  onChange: (l: number, i: number) => void;
  compact?: boolean;
}) {
  const name = React.useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 flex w-full items-center justify-between text-xs font-medium text-muted">
        <span>{label}</span>
        {l && i ? <RatingBadge rating={ratingFor(l * i)} score={l * i} /> : <span className="text-[11px]">Not set</span>}
      </legend>
      <Axes compact={compact}>
        <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label={label}>
          {LEVELS.map((ll) =>
            IMPACTS.map((ii) => {
              const checked = ll === l && ii === i;
              const s = ll * ii;
              return (
                <label
                  key={`${ll}-${ii}`}
                  className={cn(
                    'relative flex cursor-pointer items-center justify-center rounded text-[11px] tabular-nums transition',
                    compact ? 'h-6' : 'h-8',
                    'hover:brightness-110',
                    checked ? 'ring-2 ring-fg font-semibold text-fg' : 'text-fg/60',
                  )}
                  style={{ background: RATING_FILL[ratingFor(s)] }}
                  title={`${LIKELIHOOD_LABELS[ll - 1]} × ${IMPACT_LABELS[ii - 1]} = ${s}`}
                >
                  <input
                    type="radio"
                    name={name}
                    className="sr-only"
                    checked={checked}
                    onChange={() => onChange(ll, ii)}
                    aria-label={`Likelihood ${LIKELIHOOD_LABELS[ll - 1]}, impact ${IMPACT_LABELS[ii - 1]}, score ${s}`}
                  />
                  {checked ? s : ''}
                </label>
              );
            }),
          )}
        </div>
      </Axes>
    </fieldset>
  );
}

/**
 * Inherent (I) → residual (R) → target (T) on one matrix, with arrows. The single most useful
 * picture in a risk review: how much the controls buy, and how much the plan still promises.
 */
export function ScoreTrail({
  inherent, residual, target,
}: {
  inherent: [number, number];
  residual: [number, number];
  target: [number, number] | null;
}) {
  // Grid geometry in a 100x100 viewBox; cell centres.
  const cx = (i: number) => (i - 0.5) * 20;
  const cy = (l: number) => (5 - l + 0.5) * 20;
  const pts: Array<{ key: string; l: number; i: number; tone: string }> = [
    { key: 'I', l: inherent[0], i: inherent[1], tone: 'var(--muted)' },
    { key: 'R', l: residual[0], i: residual[1], tone: 'var(--fg)' },
    ...(target ? [{ key: 'T', l: target[0], i: target[1], tone: 'var(--success)' }] : []),
  ];
  return (
    <Axes compact>
      <div className="relative">
        <div className="grid grid-cols-5 gap-0.5" aria-hidden>
          {LEVELS.map((l) => IMPACTS.map((i) => (
            <div key={`${l}-${i}`} className="aspect-square rounded-sm" style={{ background: RATING_FILL[ratingFor(l * i)] }} />
          )))}
        </div>
        <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full" role="img"
          aria-label={`Inherent ${inherent[0] * inherent[1]}, residual ${residual[0] * residual[1]}${target ? `, target ${target[0] * target[1]}` : ''}`}>
          <defs>
            <marker id="risk-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="hsl(var(--fg))" />
            </marker>
          </defs>
          {pts.slice(1).map((p, idx) => {
            const a = pts[idx];
            if (a.l === p.l && a.i === p.i) return null;
            return (
              <line key={p.key} x1={cx(a.i)} y1={cy(a.l)} x2={cx(p.i)} y2={cy(p.l)}
                stroke="hsl(var(--fg))" strokeWidth="1.2" strokeDasharray={p.key === 'T' ? '3 2' : undefined}
                markerEnd="url(#risk-arrow)" opacity="0.8" />
            );
          })}
          {pts.map((p, idx) => {
            // Offset coincident points so every marker stays readable.
            const dup = pts.slice(0, idx).filter((q) => q.l === p.l && q.i === p.i).length;
            return (
              <g key={p.key} transform={`translate(${cx(p.i) + dup * 5} ${cy(p.l) - dup * 5})`}>
                <circle r="6" fill="hsl(var(--surface))" stroke={`hsl(${p.tone})`} strokeWidth="1.6" />
                <text textAnchor="middle" dy="2.4" fontSize="7" fontWeight="700" fill={`hsl(${p.tone})`}>{p.key}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </Axes>
  );
}
