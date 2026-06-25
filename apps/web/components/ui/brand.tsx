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

/**
 * Emblem + wordmark lockup (optionally with the "ITSM Platform" tagline).
 * `stacked` arranges the mark centered above the wordmark so the emblem,
 * wordmark, and anything below share a single vertical center axis (used in
 * the landing hero); the default horizontal lockup is used in the navbar.
 */
export function BrandLockup({
  size = 32,
  tagline = false,
  stacked = false,
  className,
}: {
  size?: number;
  tagline?: boolean;
  stacked?: boolean;
  className?: string;
}) {
  const wordmark = (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: stacked ? 'center' : 'flex-start',
        lineHeight: 1.02,
      }}
    >
      <span className="font-semibold tracking-tight text-fg" style={{ fontSize: size * 0.66 }}>Anchor</span>
      {tagline && (
        <span
          className="font-medium uppercase text-muted"
          // Pad the leading edge to offset trailing letter-spacing so the
          // tagline optically centers under the wordmark when stacked.
          style={{ fontSize: size * 0.235, letterSpacing: '0.22em', paddingLeft: stacked ? '0.22em' : undefined }}
        >
          ITSM Platform
        </span>
      )}
    </span>
  );

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        flexDirection: stacked ? 'column' : 'row',
        alignItems: 'center',
        gap: stacked ? size * 0.2 : size * 0.26,
      }}
    >
      <BrandMark size={size} />
      {wordmark}
    </span>
  );
}
