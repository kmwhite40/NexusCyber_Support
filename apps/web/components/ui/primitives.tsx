'use client';
// Vendored, 21st.dev-style primitives (Tailwind + shadcn lineage). Copied into the
// repo and governed as first-party code — no runtime third-party fetch, which is a
// hard requirement for government enclaves (docs/nexus/10 §V.2).
import * as React from 'react';
import { cn } from '@/lib/cn';

export function Button({
  className,
  variant = 'default',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}) {
  const variants: Record<string, string> = {
    default:
      'bg-brand text-brand-fg hover:brightness-110 shadow-[0_8px_24px_-12px_hsl(var(--brand)/0.7)] font-medium',
    outline: 'border border-border bg-surface/40 hover:bg-surface-2 text-fg',
    ghost: 'hover:bg-surface-2 text-fg',
    subtle: 'bg-surface-2 hover:bg-border text-fg',
    danger: 'bg-danger text-white hover:brightness-110',
  };
  const sizes: Record<string, string> = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-10 px-4 text-sm',
    lg: 'h-11 px-5 text-sm',
    icon: 'h-9 w-9',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

// forwardRef so callers can hold the element itself — Dialog needs it for focus management,
// which cannot be done through props alone.
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border border-border glass shadow-card animate-fade-up',
          className,
        )}
        {...props}
      />
    );
  },
);
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pb-3', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight text-fg', className)} {...props} />;
}
export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-2', className)} {...props} />;
}


/**
 * Field hands its generated ids down to whichever control it wraps.
 *
 * A review counted 23 labels in the app with ONE htmlFor, and 74 inputs with no id — so a screen
 * reader announced nearly every control in the product as unnamed. Context rather than
 * cloneElement, because controls are often wrapped (a picker, a conditional) and cloning only
 * reaches a direct child.
 */
const FieldContext = React.createContext<{ id: string; describedBy?: string } | null>(null);

/**
 * Inside a Field, the FIELD's id wins — the label already points at it, and letting a caller's id
 * through would silently break the association the label depends on. Outside a Field, an explicit
 * id passes through untouched. No caller currently sets one inside a Field; if a case ever needs
 * it, the fix is for Field to accept the id, not for the control to diverge from its label.
 */
function useFieldIds(explicitId?: string, explicitDescribedBy?: string) {
  const ctx = React.useContext(FieldContext);
  return {
    id: ctx?.id ?? explicitId,
    'aria-describedby': explicitDescribedBy ?? ctx?.describedBy,
  };
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds(props.id, props['aria-describedby']);
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-border bg-surface-2/60 px-3 text-sm text-fg placeholder:text-muted',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
      {...ids}
    />
  );
}
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ids = useFieldIds(props.id, props['aria-describedby']);
  return (
    <textarea
      className={cn(
        'min-h-[96px] w-full rounded-md border border-border bg-surface-2/60 px-3 py-2 text-sm text-fg placeholder:text-muted',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
      {...ids}
    />
  );
}
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(props.id, props['aria-describedby']);
  return (
    <select
      className={cn(
        'h-10 w-full rounded-md border border-border bg-surface-2/60 px-3 text-sm text-fg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
      {...ids}
    />
  );
}
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-xs font-medium text-muted', className)} {...props} />;
}
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  // The hint is the only place some fields explain themselves ("Write-only. Never shown again.").
  // Unassociated, a screen-reader user never hears it at all.
  const value = React.useMemo(() => ({ id, describedBy: hint ? hintId : undefined }), [id, hintId, hint]);
  return (
    <FieldContext.Provider value={value}>
      <div className="mb-4">
        <Label htmlFor={id}>{label}</Label>
        {children}
        {hint && <p id={hintId} className="mt-1 text-xs text-muted">{hint}</p>}
      </div>
    </FieldContext.Provider>
  );
}

/** A controlled segmented control / tab switcher. Replaces the hand-rolled
 *  raw-button tab groups that drifted across analytics/dashboards/changes/services. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: ReadonlyArray<{ value: T; label: React.ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const pad = size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm';
  return (
    <div
      role="tablist"
      className={cn('inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2/60 p-1', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active ? 'true' : 'false'}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
              pad,
              active ? 'bg-brand text-brand-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Brand-accented checkbox; replaces native checkboxes for visual consistency. */
export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'h-4 w-4 rounded border-border bg-surface-2/60 accent-[hsl(var(--brand))]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-2 text-muted border-border',
    brand: 'bg-brand/15 text-brand border-brand/30',
    success: 'bg-success/15 text-success border-success/30',
    warning: 'bg-warning/15 text-warning border-warning/30',
    danger: 'bg-danger/15 text-danger border-danger/30',
    accent: 'bg-accent/15 text-accent border-accent/30',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
