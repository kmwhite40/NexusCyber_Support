'use client';
// Site-wide rolling (marquee) banner pinned to the top of every page. Red background,
// white font. Announces the after-hours on-call hotline. Pauses on hover so it's readable.
import * as React from 'react';

const MESSAGE =
  'After hours, weekends, or federal holidays: call the after-hours on-call NexusCyber Hotline — (800) 265-6446 — for any P1 critical issue.';

function Segment() {
  // One repeating group; two of these side by side make a seamless -50% loop.
  return (
    <div className="flex shrink-0">
      {[0, 1, 2].map((i) => (
        <span key={i} className="px-10">{MESSAGE}</span>
      ))}
    </div>
  );
}

export function HotlineBanner() {
  return (
    <div
      className="w-full overflow-hidden border-b border-red-800"
      style={{ backgroundColor: '#dc2626', color: '#ffffff' }}
      role="status"
      aria-label={MESSAGE}
    >
      <div aria-hidden className="flex w-max py-1.5 text-sm font-medium [animation:anchor-marquee_38s_linear_infinite] hover:[animation-play-state:paused]">
        <Segment />
        <Segment />
      </div>
      <style>{`@keyframes anchor-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}
