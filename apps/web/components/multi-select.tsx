'use client';
import * as React from 'react';
import { Input, Checkbox } from '@/components/ui/primitives';

/**
 * Choose several values from a list.
 *
 * Built for "Security / distribution groups", which was a free-text box. Requesters typed group
 * names from memory, so a mistyped one became a `group_missing` blocker only after the request
 * had been approved — and far more often the box was left blank and the new hire was provisioned
 * into no groups at all. A name that is chosen rather than typed cannot be either.
 *
 * The options usually arrive from a live source (form_fields.options_source), so three states
 * that look identical if you render nothing are each said out loud instead: the list is empty,
 * the filter matched nothing, and the list is known to be short of the full set.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  truncated = false,
  emptyLabel = 'No groups are available to choose from right now.',
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  /** The source stopped before the end. Saying so beats presenting a short list as everything. */
  truncated?: boolean;
  emptyLabel?: string;
}) {
  const [q, setQ] = React.useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options;

  const toggle = (o: string) => {
    onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  };

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {/* Chips list the CHOSEN values, including any the options list no longer contains —
              a value picked before the live list arrived, or a group since deleted from the
              tenant. Hiding those would quietly narrow a request someone already filled in. */}
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
              {v}
              <button type="button" className="text-muted hover:text-fg" onClick={() => toggle(v)} aria-label={`Remove ${v}`}>×</button>
            </span>
          ))}
        </div>
      )}
      {options.length > 0 && (
        <Input value={q} placeholder="Filter…" onChange={(e) => setQ(e.target.value)} />
      )}
      {options.length === 0 ? (
        <p className="mt-1 text-xs text-warning">{emptyLabel}</p>
      ) : shown.length === 0 ? (
        <p className="mt-1 text-xs text-warning">No matches for “{q.trim()}”.</p>
      ) : (
        <ul className="mt-2 max-h-56 overflow-auto rounded-md border border-border">
          {shown.map((o) => (
            <li key={o} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-2">
              <Checkbox id={`ms-${o}`} checked={value.includes(o)} onChange={() => toggle(o)} />
              <label htmlFor={`ms-${o}`} className="cursor-pointer text-sm text-fg">{o}</label>
            </li>
          ))}
        </ul>
      )}
      {truncated && (
        <p className="mt-1 text-xs text-warning">
          This is not the complete list — there are more groups than can be shown. Ask an
          administrator if the one you need is missing.
        </p>
      )}
    </div>
  );
}
