'use client';
// Site-entry welcome dialog — shown once per browser session on any page. Presents support
// hours, the SLA priority matrix, and the after-hours hotline. Dismiss persists for the
// session (sessionStorage) so it appears when someone "enters the site" but not on every nav.
import * as React from 'react';
import { X } from 'lucide-react';
import { BrandMark } from './ui/brand';
import { Button } from './ui/primitives';
import { useAuth } from './auth-context';

const SLA_ROWS: Array<{ p: string; label: string; tone: string; meaning: string; ack: string; resolve: string }> = [
  { p: 'P1', label: 'Critical', tone: 'bg-danger', meaning: "You're blocked tenant-wide, locked out of all admin, or there's a security incident", ack: '1 hour', resolve: '4 hours' },
  { p: 'P2', label: 'High', tone: 'bg-warning', meaning: 'A single user is locked out, or service is degraded', ack: '4 business hours', resolve: '1 business day' },
  { p: 'P3', label: 'Standard', tone: 'bg-brand', meaning: 'Routine change — reset, group, license, onboarding', ack: '1 business day', resolve: '5 business days' },
  { p: 'P4', label: 'Low', tone: 'bg-muted', meaning: 'How-to, documentation, advisory', ack: '2 business days', resolve: '10 business days' },
];

const STORAGE_KEY = 'anchor-welcome-seen';

export function WelcomeDialog() {
  const { me } = useAuth();
  const [open, setOpen] = React.useState(false);

  // Show once per login for every signed-in user (admins included). Keyed to the user id
  // and reset on logout (auth-context), so a fresh login re-shows it — but a page refresh
  // while still signed in does not.
  React.useEffect(() => {
    if (!me) { setOpen(false); return; }
    try {
      if (sessionStorage.getItem(STORAGE_KEY) !== me.id) setOpen(true);
    } catch {
      setOpen(true);
    }
  }, [me]);

  const close = React.useCallback(() => {
    try { sessionStorage.setItem(STORAGE_KEY, me?.id ?? '1'); } catch { /* ignore */ }
    setOpen(false);
  }, [me]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      onClick={close}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border px-6 py-5">
          <BrandMark size={40} />
          <div className="flex-1">
            <h2 id="welcome-title" className="text-lg font-semibold tracking-tight text-fg">
              Welcome to the NexusCyber (Anchor) Support page.
            </h2>
            <p className="mt-0.5 text-sm text-muted">Here&apos;s how and when we support you.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={close} aria-label="Close" className="text-muted hover:text-fg">
            <X aria-hidden className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>

        <div className="space-y-6 px-6 py-5">
          {/* Hours */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-brand">Support hours</h3>
            <p className="text-sm text-fg">
              Business hours are <strong>Monday–Friday, 7:00 AM – 6:00 PM PST</strong>, excluding U.S. federal holidays.
              The on-call hotline covers every hour outside that window:
            </p>
            <ul className="mt-2 space-y-1 pl-5 text-sm text-fg/90">
              <li className="list-disc"><strong>Weeknights</strong> — Monday – Friday, 6:00 PM – 7:00 AM PST.</li>
              <li className="list-disc"><strong>Weekends</strong> — Friday 6:00 PM ET through Monday 7:00 AM PST.</li>
              <li className="list-disc"><strong>U.S. federal holidays</strong> — full-day on-call coverage.</li>
            </ul>
          </section>

          {/* SLA table */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-brand">Priority &amp; response targets</h3>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-semibold">Priority</th>
                    <th className="px-3 py-2 font-semibold">What it means for you</th>
                    <th className="px-3 py-2 font-semibold">We acknowledge</th>
                    <th className="px-3 py-2 font-semibold">We aim to resolve</th>
                  </tr>
                </thead>
                <tbody>
                  {SLA_ROWS.map((r) => (
                    <tr key={r.p} className="border-t border-border align-top">
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-fg">
                          <span className={`h-2 w-2 rounded-full ${r.tone}`} />{r.p} {r.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-fg/85">{r.meaning}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-fg/85">{r.ack}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-fg/85">{r.resolve}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* After-hours hotline */}
          <div className="rounded-lg border border-brand/40 bg-brand/5 px-4 py-3 text-sm text-fg">
            After hours, weekends, or federal holidays: call the after-hours on-call{' '}
            <strong>NexusCyber Hotline — (800) 265-6446</strong> — for any P1 critical issue.
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-border px-6 py-4">
          <Button variant="default" onClick={close}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
