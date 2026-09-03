import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestModal } from '@/components/catalog-request-modal';

// The dialog used to close on ANY click reaching its backdrop, discarding everything typed with
// no warning. A catalog form can run to thirty fields, and clicks from portalled dropdowns (the
// user picker, date inputs) bubble straight past the card's stopPropagation — so this was not a
// rare misclick, it was the normal way to lose a form.
vi.mock('@/components/auth-context', () => ({ useAuth: () => ({ me: { plane: 'customer' } }) }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<any>('@/lib/api');
  return {
    ...actual,
    catalog: { form: vi.fn(async () => null), request: vi.fn(async () => ({ id: 't1' })) },
    users: { search: vi.fn(async () => []) },
    api: { get: vi.fn(async () => ({ data: [] })) },
    attachmentsApi: { upload: vi.fn() },
  };
});

const item = { key: 'user.provisioning', name: 'New user creation & provisioning' } as any;

function renderModal(onClose = vi.fn()) {
  render(<RequestModal item={item} orgs={[]} isAgent={false} onClose={onClose} onCreated={vi.fn()} />);
  return onClose;
}

describe('catalog request dialog dismissal', () => {
  beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });

  it('does not close when the backdrop is clicked', async () => {
    const onClose = renderModal();
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(backdrop).toBeTruthy();
    await userEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Cancel when nothing has been typed, without nagging', async () => {
    const onClose = renderModal();
    await screen.findAllByRole('textbox');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before discarding a form that has been filled in', async () => {
    const onClose = renderModal();
    await userEvent.type((await screen.findAllByRole('textbox'))[0], 'a real request');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the form open when the discard prompt is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = renderModal();
    await userEvent.type((await screen.findAllByRole('textbox'))[0], 'a real request');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('routes Escape through the same guard', async () => {
    const onClose = renderModal();
    await userEvent.type((await screen.findAllByRole('textbox'))[0], 'typed');
    await userEvent.keyboard('{Escape}');
    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // The submit control sits OUTSIDE the scrolling body, in a pinned footer, so a long form
  // cannot push it out of reach. It stays wired to the form by id rather than by nesting.
  it('keeps Send outside the scroll area but still submitting the form', async () => {
    renderModal();
    const send = await screen.findByRole('button', { name: /send/i });
    const form = document.querySelector('form') as HTMLFormElement;
    expect(send.getAttribute('form')).toBe(form.id);
    expect(form.contains(send)).toBe(false);
  });
});
