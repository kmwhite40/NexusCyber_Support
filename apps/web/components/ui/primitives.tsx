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

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border glass shadow-card animate-fade-up',
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pb-3', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight text-fg', className)} {...props} />;
}
export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-2', className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-border bg-surface-2/60 px-3 text-sm text-fg placeholder:text-muted',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
    />
  );
}
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-[96px] w-full rounded-md border border-border bg-surface-2/60 px-3 py-2 text-sm text-fg placeholder:text-muted',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
    />
  );
}
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-10 w-full rounded-md border border-border bg-surface-2/60 px-3 text-sm text-fg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 transition',
        className,
      )}
      {...props}
    />
  );
}
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-xs font-medium text-muted', className)} {...props} />;
}
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-4">
      <Label>{label}</Label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
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
