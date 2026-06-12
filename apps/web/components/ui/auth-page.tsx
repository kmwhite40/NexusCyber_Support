'use client';
// Vendored 21st.dev auth page — split-screen with an animated FloatingPaths brand
// panel. We expose `AuthLayout` + `FloatingPaths` so our real (functional) login and
// signup pages reuse the design while keeping our own auth logic. The original static
// `AuthPage` is kept for reference.
import React from 'react';
import { motion } from 'framer-motion';
import { BrandMark } from './brand';

export function FloatingPaths({ position }: { position: number }) {
  const paths = Array.from({ length: 36 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position} -${189 + i * 6} -${
      312 - i * 5 * position
    } ${216 - i * 6} ${152 - i * 5 * position} ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${
      684 - i * 5 * position
    } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    width: 0.5 + i * 0.03,
  }));

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg className="h-full w-full text-foreground" viewBox="0 0 696 316" fill="none">
        <title>Background Paths</title>
        {paths.map((path) => (
          <motion.path
            key={path.id}
            d={path.d}
            stroke="currentColor"
            strokeWidth={path.width}
            strokeOpacity={0.06 + path.id * 0.012}
            initial={{ pathLength: 0.3, opacity: 0.5 }}
            animate={{ pathLength: 1, opacity: [0.2, 0.5, 0.2], pathOffset: [0, 1, 0] }}
            transition={{ duration: 20 + (path.id % 10), repeat: Number.POSITIVE_INFINITY, ease: 'linear' }}
          />
        ))}
      </svg>
    </div>
  );
}

/** Split-screen auth shell: animated brand panel + a form panel for `children`. */
export function AuthLayout({
  children,
  quote = 'This platform helps us serve our customers faster — across commercial and government clouds.',
  quoteBy = 'Anchor Service Desk',
}: {
  children: React.ReactNode;
  quote?: string;
  quoteBy?: string;
}) {
  return (
    <main className="relative lg:grid lg:min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col overflow-hidden border-r border-border bg-surface p-10 lg:flex">
        <div className="absolute inset-0">
          <FloatingPaths position={1} />
          <FloatingPaths position={-1} />
        </div>
        <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <div className="relative z-20 flex items-center gap-2.5">
          <BrandMark size={30} />
          <span className="text-xl font-semibold">
            Anchor
          </span>
        </div>
        <div className="relative z-20 mt-auto">
          <blockquote className="space-y-2">
            <p className="text-xl leading-relaxed text-fg/90">&ldquo;{quote}&rdquo;</p>
            <footer className="font-mono text-sm font-semibold text-muted">~ {quoteBy}</footer>
          </blockquote>
        </div>
      </div>

      {/* Form panel */}
      <div className="relative flex min-h-screen flex-col justify-center p-4">
        <div className="mx-auto w-full max-w-sm space-y-5">{children}</div>
      </div>
    </main>
  );
}

/** Re-usable OR separator. */
export function AuthSeparator({ label = 'OR' }: { label?: string }) {
  return (
    <div className="flex w-full items-center justify-center">
      <div className="h-px w-full bg-border" />
      <span className="px-2 text-xs text-muted">{label}</span>
      <div className="h-px w-full bg-border" />
    </div>
  );
}
