'use client';
// Site-wide rolling (marquee) banner pinned to the top of every page. Red background,
// white font. Rotates the after-hours on-call hotline notice and a data-handling warning
// (do not upload CUI/sensitive data to tickets). Pauses on hover so it's readable.
import * as React from 'react';

const MESSAGES = [
  'After hours, weekends, or federal holidays: call the after-hours on-call NexusCyber Hotline — (800) 265-6446 — for any P1 critical issue.',
  '⚠ Do NOT upload CUI, PII, credentials, or sensitive log files as ticket attachments. Sanitize/redact attachments before submitting, in accordance with FedRAMP and CUI handling requirements.',
];

function Segment() {
  // One repeating group; two of these side by side make a seamless -50% loop.
  return (
    <div className="flex shrink-0 items-center">
      {MESSAGES.map((m, i) => (
        <React.Fragment key={i}>
          <span className="px-10">{m}</span>
          <span aria-hidden className="opacity-60">•</span>
        </React.Fragment>
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
      aria-label={MESSAGES.join(' ')}
    >
      <div aria-hidden className="flex w-max py-1.5 text-sm font-medium [animation:anchor-marquee_52s_linear_infinite] hover:[animation-play-state:paused]">
        <Segment />
        <Segment />
      </div>
      <style>{`@keyframes anchor-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}
