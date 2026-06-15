'use client';
// Anchor brand mark — a stylized anchor formed from three circuit "nodes" (a large
// shackle ring up top with a stem, and two smaller side rings whose arms sweep down
// to a central point). Inline SVG so it stays crisp and inherits sizing. The blue
// gradient is the brand signature; matches public/anchor-mark.svg + app/icon.svg.
import * as React from 'react';

/** The shared anchor geometry (viewBox 0 0 64 64), parameterized by a gradient id. */
function AnchorPaths({ gid }: { gid: string }) {
  return (
    <g stroke={`url(#${gid})`} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="32" cy="15" r="6.5" />
      <path d="M32 21.5 V46.5" />
      <circle cx="15" cy="27" r="4.5" />
      <path d="M15 31.5 C15 41.5, 22 46.5, 32 46.5" />
      <circle cx="49" cy="27" r="4.5" />
      <path d="M49 31.5 C49 41.5, 42 46.5, 32 46.5" />
    </g>
  );
}

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const gid = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} role="img" aria-label="Anchor">
      <defs>
        <linearGradient id={gid} x1="8" y1="8" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1e40af" />
          <stop offset="0.55" stopColor="#2563eb" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <AnchorPaths gid={gid} />
    </svg>
  );
}

/** Emblem + wordmark lockup (optionally with the "ITSM Platform" tagline). */
export function BrandLockup({ size = 32, tagline = false, className }: { size?: number; tagline?: boolean; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <BrandMark size={size} />
      <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.05 }}>
        <span className="font-semibold tracking-tight text-fg" style={{ fontSize: size * 0.62 }}>Anchor</span>
        {tagline && (
          <span className="font-medium uppercase text-muted" style={{ fontSize: size * 0.26, letterSpacing: '0.18em' }}>
            ITSM Platform
          </span>
        )}
      </span>
    </span>
  );
}
