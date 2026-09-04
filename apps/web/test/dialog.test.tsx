import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '@/components/ui/dialog';

// Three pages each defined their own identically-signatured `Modal`, and all three closed on a
// backdrop click with no dirty check — the same data-loss bug already fixed once in the catalog
// dialog. A shared primitive is the only thing that stops a fourth copy reintroducing it.
describe('Dialog', () => {
  it('does not close on a backdrop click by default', async () => {
    const onClose = vi.fn();
    render(<Dialog title="Edit user" onClose={onClose}><p>body</p></Dialog>);
    await userEvent.click(document.querySelector('[data-dialog-backdrop]') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a backdrop click only when the caller opts in', async () => {
    const onClose = vi.fn();
    render(<Dialog title="Preview" onClose={onClose} dismissOnBackdrop><p>body</p></Dialog>);
    await userEvent.click(document.querySelector('[data-dialog-backdrop]') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog title="Edit user" onClose={onClose}><p>body</p></Dialog>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  // The people picker inside these dialogs closes its own list on Escape from the CAPTURE phase.
  // If the dialog also captured, whichever mounted first would win and one Escape would discard a
  // half-filled form instead of closing a dropdown. The dialog listens on the bubble phase so the
  // innermost open thing always wins.
  it('lets a capture-phase child preempt Escape', async () => {
    const onClose = vi.fn();
    const onCapture = vi.fn((e: KeyboardEvent) => { e.stopPropagation(); });
    window.addEventListener('keydown', onCapture, true);
    try {
      render(<Dialog title="Edit user" onClose={onClose}><p>body</p></Dialog>);
      await userEvent.keyboard('{Escape}');
      expect(onCapture).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onCapture, true);
    }
  });

  it('is announced as a modal dialog labelled by its title', () => {
    render(<Dialog title="Delete organization" onClose={vi.fn()}><p>body</p></Dialog>);
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg).toHaveAccessibleName('Delete organization');
  });

  it('moves focus into the dialog and restores it on close', async () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open</button>
          {open && <Dialog title="Edit" onClose={() => setOpen(false)}><button type="button">inside</button></Dialog>}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open' });
    await userEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
