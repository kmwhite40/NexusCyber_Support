'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Card } from './primitives';

export function StatCard({
  label,
  value,
  delta,
  icon,
  tone = 'brand',
}: {
  label: string;
  value: React.ReactNode;
  delta?: { value: string; positive?: boolean };
  icon?: React.ReactNode;
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  const ring: Record<string, string> = {
    brand: 'from-brand/20', success: 'from-success/20', warning: 'from-warning/20',
    danger: 'from-danger/20', accent: 'from-accent/20',
  };
  return (
    <Card className="relative overflow-hidden p-5">
      <div className={cn('pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br to-transparent blur-2xl', ring[tone])} />
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-semibold tracking-tight text-fg tabular-nums">{value}</span>
        {delta && (
          <span className={cn('mb-1 text-xs font-medium', delta.positive ? 'text-success' : 'text-danger')}>
            {delta.positive ? '▲' : '▼'} {delta.value}
          </span>
        )}
      </div>
    </Card>
  );
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  onRowClick,
  empty,
}: {
  columns: Array<{ key: string; header: string; render: (row: T) => React.ReactNode; className?: string }>;
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
}) {
  if (rows.length === 0) return <div className="p-10">{empty ?? <EmptyState title="Nothing here yet" />}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            {columns.map((c) => (
              <th key={c.key} className={cn('px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onRowClick?.(row)}
              className={cn(
                'border-b border-border/60 transition-colors',
                onRowClick && 'cursor-pointer hover:bg-surface-2/60',
              )}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-4 py-3 align-middle', c.className)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface-2 text-muted">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M9 17h6M9 13h6M9 9h2M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
        </svg>
      </div>
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      {description && <p className="mt-1 max-w-sm text-xs text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />;
}
