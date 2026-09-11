'use client';
import * as React from 'react';
import { Star } from 'lucide-react';

/**
 * A one-to-five star rating.
 *
 * Built for the public satisfaction survey, which is answered by people who are not signed in,
 * usually on a phone, once. So it is a real radio group rather than a row of clickable icons:
 * it works from the keyboard, it announces itself to a screen reader, and the chosen value is
 * stated in words as well as in colour — there is no administrator on the other side of this
 * form to do it for them if it does not.
 */
export function StarRating({
  label, value, onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
}) {
  const groupId = React.useId();
  return (
    <div>
      <p id={groupId} className="mb-2 text-sm font-medium text-fg">{label}</p>
      <div role="radiogroup" aria-labelledby={groupId} className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = value != null && n <= value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} out of 5`}
              // Roving tabindex: the group is one tab stop, and the arrow keys move within it —
              // five separate stops per question would make a three-question form fifteen.
              tabIndex={value === n || (value == null && n === 1) ? 0 : -1}
              onClick={() => onChange(n)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(Math.min(5, (value ?? 0) + 1)); }
                if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(1, (value ?? 2) - 1)); }
              }}
              className="rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            >
              <Star
                className={`h-8 w-8 ${filled ? 'fill-warning text-warning' : 'text-muted'}`}
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </button>
          );
        })}
        <span className="ml-2 text-xs text-muted">
          {value == null ? 'Not rated yet' : `${value} out of 5`}
        </span>
      </div>
    </div>
  );
}
