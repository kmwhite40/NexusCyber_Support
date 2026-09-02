'use client';
// Month-grid change calendar backed by GET /changes/calendar (scheduled + implementing).
// Extracted verbatim from the changes page; behaviour unchanged.
import * as React from 'react';
import { Card, CardHeader, CardTitle, CardBody, Button } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/data';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { changesApi, type Change } from '@/lib/changes';

const riskBar = (r: string) => (r === 'high' ? 'bg-danger' : r === 'medium' ? 'bg-warning' : 'bg-brand');

export function ChangeCalendar({ onOpen }: { onOpen: (id: string) => void }) {
  const [month, setMonth] = React.useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [items, setItems] = React.useState<Change[] | null>(null);

  React.useEffect(() => {
    const from = new Date(month.getFullYear(), month.getMonth(), 1);
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    setItems(null);
    changesApi
      .calendar(from.toISOString(), to.toISOString())
      .then(setItems)
      .catch(() => setItems([]));
  }, [month]);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay()); // back to the Sunday on/before the 1st
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const today = new Date();
  const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const changesOn = (day: Date) =>
    (items ?? []).filter((c) => {
      if (!c.window_start) return false;
      const s = new Date(c.window_start);
      const e = c.window_end ? new Date(c.window_end) : s;
      const d0 = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const d1 = new Date(d0);
      d1.setDate(d0.getDate() + 1);
      return s < d1 && e >= d0;
    });

  const monthLabel = month.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <Card>
      <CardHeader>
        <div className="flex w-full items-center justify-between">
          <CardTitle>{monthLabel}</CardTitle>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></Button>
            <Button size="sm" variant="subtle" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</Button>
            <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></Button>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {items === null ? (
          <Skeleton className="h-72" />
        ) : (
          <>
            <div className="grid grid-cols-7 gap-px border-b border-border pb-1 text-center text-[11px] font-semibold uppercase tracking-wider text-muted">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-px overflow-hidden rounded-md bg-border">
              {days.map((day, i) => {
                const inMonth = day.getMonth() === month.getMonth();
                const dayChanges = changesOn(day);
                return (
                  <div key={i} className={`min-h-[92px] bg-surface p-1 ${inMonth ? '' : 'opacity-45'}`}>
                    <div className={`mb-0.5 text-right text-[11px] ${isSameDay(day, today) ? 'font-bold text-brand' : 'text-muted'}`}>{day.getDate()}</div>
                    <div className="space-y-0.5">
                      {dayChanges.slice(0, 3).map((c) => (
                        <button
                          key={c.id}
                          onClick={() => onOpen(c.id)}
                          title={`${c.title} — ${c.risk} risk, ${c.status}`}
                          className="flex w-full items-center gap-1 truncate rounded bg-surface-2 px-1 py-0.5 text-left text-[10px] text-fg hover:bg-surface-2/70"
                        >
                          <span className={`h-2 w-1 shrink-0 rounded-sm ${riskBar(c.risk)}`} />
                          <span className="truncate">{c.window_start ? new Date(c.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} {c.title}</span>
                        </button>
                      ))}
                      {dayChanges.length > 3 && <div className="px-1 text-[10px] text-muted">+{dayChanges.length - 3} more</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-4 text-[11px] text-muted">
              <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${riskBar('high')}`} /> High</span>
              <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${riskBar('medium')}`} /> Medium</span>
              <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${riskBar('low')}`} /> Low</span>
              <span className="ml-auto">Scheduled &amp; implementing changes</span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
