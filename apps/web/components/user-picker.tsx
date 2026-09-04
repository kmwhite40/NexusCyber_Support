'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
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
  const boxRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const [rect, setRect] = React.useState<{ left: number; top: number; width: number; above: boolean } | null>(null);

  // The list is PORTALLED to the body and positioned fixed, rather than absolutely positioned in
  // place. Inside the service-catalog dialog it lives in a scrolling `overflow-auto` body: an
  // absolute child is clipped at that body's edge, so a picker low in a long form (the onboarding
  // request has thirty fields) had its list cut off and hidden behind the pinned footer. A portal
  // escapes the clip; fixed positioning keeps it attached to the input.
  const place = React.useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    // Flip above when there is more room there — otherwise a picker near the bottom of the
    // viewport opens into nothing.
    const above = below < 240 && r.top > below;
    setRect({ left: r.left, top: above ? r.top : r.bottom, width: r.width, above });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    place();
    // Recompute while the dialog body scrolls underneath, or the list drifts away from its input.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place, hits.length]);

  // The list had no way to close: no outside click, no Escape, and picking in multi-select mode
  // left it open. With two people in an org that was survivable; with a full roster it covers the
  // rest of the form and there is no way past it.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The list is portalled, so it is NOT inside boxRef — without checking it too, clicking a
      // result would register as an outside click and close the list before the pick landed.
      if (boxRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    // CAPTURE phase, on purpose. A dialog containing this picker listens for Escape on window to
    // close itself; without capturing first, one Escape would close the list AND discard the form
    // behind it. Capturing lets the innermost thing win, which is what Escape should always do.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

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
    <div className="relative" ref={boxRef}>
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
      {open && hits.length > 0 && rect && createPortal((
        <ul
          ref={listRef}
          style={{
            position: 'fixed', left: rect.left, width: rect.width,
            ...(rect.above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.top + 4 }),
          }}
          className="z-50 max-h-56 overflow-auto rounded-md border border-border bg-surface shadow-lg"
        >
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
      ), document.body)}
    </div>
  );
}
