'use client';
// Site-wide rolling (marquee) banner pinned to the top of every page. Red background,
// white font. Rotates the after-hours on-call hotline notice and a data-handling warning
// (do not upload CUI/sensitive data to tickets). Pauses on hover so it's readable.
import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

const MESSAGES = [
  'After hours, weekends, or federal holidays: call the after-hours on-call NexusCyber Hotline — (800) 265-6446 — for any P1 critical issue.',
  'Do NOT upload CUI, PII, credentials, or sensitive log files as ticket attachments. Sanitize/redact attachments before submitting, in accordance with FedRAMP and CUI handling requirements.',
];

function Segment() {
  // One repeating group; two of these side by side make a seamless -50% loop.
  return (
    <div className="flex shrink-0 items-center">
      {MESSAGES.map((m, i) => (
        <React.Fragment key={i}>
          <span className="inline-flex items-center gap-1.5 px-10">
            {i === 1 && <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />}
            {m}
          </span>
          <span aria-hidden className="opacity-60">•</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function HotlineBanner() {
  // WCAG 2.2.2: content that moves for more than five seconds needs a way to stop it. This runs
  // on every page for the whole session, and hover-to-pause reaches neither keyboard nor touch
  // nor screen-reader users. So there is a real control, and it remembers the choice.
  const [paused, setPaused] = React.useState(false);

  React.useEffect(() => {
    try {
      if (localStorage.getItem('anchor.hotline.paused') === '1') setPaused(true);
      // Someone who has asked the OS to reduce motion has already answered this question.
      else if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setPaused(true);
    } catch { /* storage unavailable: default to moving, which is the existing behaviour */ }
  }, []);

  const toggle = () => {
    setPaused((p) => {
      try { localStorage.setItem('anchor.hotline.paused', p ? '0' : '1'); } catch { /* ignore */ }
      return !p;
    });
  };

  return (
    <div
      className="relative w-full overflow-hidden border-b border-danger bg-danger text-white"
      role="status"
      aria-label={MESSAGES.join(' ')}
    >
      <div
        aria-hidden
        className="flex w-max py-1.5 pr-20 text-sm font-medium [animation:anchor-marquee_52s_linear_infinite] hover:[animation-play-state:paused] motion-reduce:[animation:none]"
        style={paused ? { animationPlayState: 'paused' } : undefined}
      >
        <Segment />
        <Segment />
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={paused}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-white/40 bg-danger px-2 py-0.5 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        {paused ? 'Play' : 'Pause'}
      </button>
      <style>{`@keyframes anchor-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}
