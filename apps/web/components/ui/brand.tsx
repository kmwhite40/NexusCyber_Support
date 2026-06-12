'use client';
// NexusCyber brand mark — a four-armed circuit "nexus" emblem (4-fold rotational
// symmetry) recreated as inline SVG so it stays crisp and inherits sizing/color.
import * as React from 'react';

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const gid = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label="NexusCyber">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8eef6" />
          <stop offset="0.5" stopColor="#90a3b8" />
          <stop offset="1" stopColor="#3d4957" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${gid})`} strokeWidth="3" strokeLinecap="round">
        {[0, 90, 180, 270].map((deg) => (
          <g key={deg} transform={`rotate(${deg} 32 32)`}>
            <path d="M32 12 A20 20 0 0 1 52 32" />
            <path d="M32 19 A13 13 0 0 1 45 32" />
            <path d="M46.14 17.86 L41.19 22.81" />
            <circle cx="32" cy="12" r="2.6" fill={`url(#${gid})`} stroke="none" />
            <circle cx="41.19" cy="22.81" r="2" fill={`url(#${gid})`} stroke="none" />
          </g>
        ))}
      </g>
      <circle cx="32" cy="32" r="2.4" fill={`url(#${gid})`} />
    </svg>
  );
}

/** Emblem + wordmark lockup. */
export function BrandLockup({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <BrandMark size={size} />
      <span className="text-base font-semibold tracking-tight text-fg">
        Nexus<span className="text-muted">Cyber</span>
      </span>
    </span>
  );
}
