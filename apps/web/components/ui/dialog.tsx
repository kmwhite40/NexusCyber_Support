'use client';
// The one dialog. Three pages each defined their own identically-signatured `Modal`, and a
// review found twelve `fixed inset-0` overlays across the app in three different backdrop
// treatments — with the "backdrop click silently discards a filled form" bug living in most of
// them, after it had already been fixed once elsewhere. Duplication is why it came back.
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Card, CardBody } from '@/components/ui/primitives';

export function Dialog({
  title,
  onClose,
  children,
  wide,
  dismissOnBackdrop = false,
  footer,
  describedBy,
}: {
  title: string;
  /** Called when the user asks to close. Guard it (dirty checks, confirms) in the caller. */
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  /**
   * Off by default, on purpose. A stray click on the backdrop used to throw away a filled form
   * with no warning — and clicks from portalled dropdowns land there routinely. Opt in only for
   * dialogs holding nothing worth losing.
   */
  dismissOnBackdrop?: boolean;
  /** Pinned below the scrolling body, so a long form cannot push the actions out of reach. */
  footer?: React.ReactNode;
  describedBy?: string;
}) {
  const titleId = React.useId();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreTo = React.useRef<HTMLElement | null>(null);

  // Escape is handled on the BUBBLE phase, deliberately. Components inside a dialog — the people
  // picker's results list — close themselves on Escape from the capture phase. Capturing here too
  // would make registration order decide the winner, so one Escape could discard a half-filled
  // form instead of closing a dropdown. Bubbling last means the innermost open thing always wins.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus moves in on open and returns to whatever opened it on close. Without the restore, a
  // keyboard user is dropped at the top of the document every time they cancel.
  React.useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panelRef.current)?.focus();
    return () => restoreTo.current?.focus?.();
  }, []);

  // Tab stays inside while the dialog is open; a modal that leaks focus to the page behind it is
  // only modal for people using a mouse.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return createPortal((
    <div
      data-dialog-backdrop=""
      className="fixed inset-0 z-modal grid place-items-center bg-bg/70 p-4 backdrop-blur-sm"
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <Card
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className={`flex max-h-[90vh] w-full flex-col ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="shrink-0 px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold text-fg">{title}</h2>
        </div>
        <CardBody className="min-h-0 flex-1 space-y-2.5 overflow-auto">{children}</CardBody>
        {footer && (
          <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-4">{footer}</div>
        )}
      </Card>
    </div>
  ), document.body);
}
