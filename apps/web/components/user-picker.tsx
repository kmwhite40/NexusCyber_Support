'use client';
import * as React from 'react';
import { users, type UserHit } from '@/lib/api';
import { Input } from '@/components/ui/primitives';

// Single- or multi-select people picker backed by GET /users/search (org-scoped).
// `value` holds selected user id(s); `onChange` returns the same shape.
export function UserPicker({
  value,
  onChange,
  organizationId,
  multiple = false,
  placeholder = 'Enter name or email…',
}: {
  value: string | string[] | null;
  onChange: (v: string | string[] | null) => void;
  organizationId?: string;
  multiple?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = React.useState('');
  const [hits, setHits] = React.useState<UserHit[]>([]);
  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<Record<string, UserHit>>({});

  const selectedIds: string[] = Array.isArray(value) ? value : value ? [value] : [];

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      users.search(q, organizationId).then((r) => setHits(r.data)).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, organizationId]);

  function pick(u: UserHit) {
    setChosen((c) => ({ ...c, [u.id]: u }));
    if (multiple) {
      if (!selectedIds.includes(u.id)) onChange([...selectedIds, u.id]);
    } else {
      onChange(u.id);
      setOpen(false);
    }
    setQ('');
  }
  function remove(id: string) {
    if (multiple) onChange(selectedIds.filter((x) => x !== id));
    else onChange(null);
  }
  const label = (id: string) => chosen[id]?.display_name || chosen[id]?.email || id;

  return (
    <div className="relative">
      {selectedIds.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {selectedIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
              {label(id)}
              <button type="button" className="text-muted hover:text-fg" onClick={() => remove(id)}>×</button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={q}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
      />
      {open && hits.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-surface shadow-lg">
          {hits.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-surface-2"
                onClick={() => pick(u)}
              >
                <span className="text-sm text-fg">{u.display_name ?? u.email}</span>
                <span className="text-xs text-muted">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
