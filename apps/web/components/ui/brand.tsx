'use client';
// Anchor brand mark — the exact icon from the brand pack (transparent PNG, served
// from /public). Rendered as <img> so it stays pixel-faithful; the wordmark in
// BrandLockup is live text so the lockup blends on any (light/dark) background.
import * as React from 'react';

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/anchor-mark.png"
      alt="Anchor"
      width={size}
      height={size}
      draggable={false}
      className={className}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}

/** Emblem + wordmark lockup (optionally with the "ITSM Platform" tagline). */
export function BrandLockup({ size = 32, tagline = false, className }: { size?: number; tagline?: boolean; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.26 }}>
      <BrandMark size={size} />
      <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.02 }}>
        <span className="font-semibold tracking-tight text-fg" style={{ fontSize: size * 0.66 }}>Anchor</span>
        {tagline && (
          <span className="font-medium uppercase text-muted" style={{ fontSize: size * 0.235, letterSpacing: '0.22em' }}>
            ITSM Platform
          </span>
        )}
      </span>
    </span>
  );
}
