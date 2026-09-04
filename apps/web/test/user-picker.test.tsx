import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserPicker } from '@/components/user-picker';

// Reported from real use once the SBS roster was loaded: the picker "gets hung". It had no way to
// close — no outside-click handler, no Escape, and in multi-select mode choosing someone left it
// open. With two users in the org that was survivable; with a full roster the list covers the rest
// of the form and there is no way past it.
//
// It got worse the same day: removing backdrop click-to-close from the request dialog took away
// the accidental escape hatch, and a window-level Escape handler meant Escape discarded the whole
// form rather than closing the list.
vi.mock('@/lib/api', () => ({
  users: {
    search: vi.fn(async () => ({
      data: [
        { id: 'u1', display_name: 'Bragg, Coady', email: 'coady.bragg@sbsfederal.com' },
        { id: 'u2', display_name: 'Hite, Connor', email: 'connor.hite@sbsfederal.com' },
      ],
    })),
  },
}));

async function openList() {
  const onChange = vi.fn();
  render(<UserPicker value={null} onChange={onChange} organizationId="org-1" multiple />);
  await userEvent.click(screen.getByPlaceholderText(/enter name or email/i));
  await waitFor(() => expect(screen.getByText('Bragg, Coady')).toBeTruthy());
  return onChange;
}

describe('user picker dismissal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes when you click outside it', async () => {
    render(<div><button type="button">elsewhere</button><UserPicker value={null} onChange={vi.fn()} organizationId="org-1" multiple /></div>);
    await userEvent.click(screen.getByPlaceholderText(/enter name or email/i));
    await waitFor(() => expect(screen.getByText('Bragg, Coady')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /elsewhere/i }));
    await waitFor(() => expect(screen.queryByText('Bragg, Coady')).toBeNull());
  });

  it('closes on Escape', async () => {
    await openList();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Bragg, Coady')).toBeNull());
  });

  // Escape must close the LIST, not the dialog containing it. Otherwise dismissing a dropdown
  // throws away a form the operator has been filling in for several minutes.
  it('stops Escape reaching an enclosing dialog while the list is open', async () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    try {
      await openList();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText('Bragg, Coady')).toBeNull());
      expect(outer).not.toHaveBeenCalled();
      // Once the list is closed, Escape is the dialog's again.
      await userEvent.keyboard('{Escape}');
      expect(outer).toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });

  it('still selects people in multi-select mode', async () => {
    const onChange = await openList();
    await userEvent.click(screen.getByText('Bragg, Coady'));
    expect(onChange).toHaveBeenCalledWith(['u1']);
  });

  // Inside the service-catalog dialog the picker lives in a scrolling `overflow-auto` body. An
  // absolutely-positioned list is clipped at that body's edge, so a picker low in a long form
  // (the onboarding request has thirty fields) had its results cut off and hidden behind the
  // pinned footer. Portalling to the body escapes the clip — which is only true if the list is
  // genuinely not a descendant of the scrolling element.
  it('renders the list outside a scrolling ancestor, not clipped inside it', async () => {
    render(
      <div data-testid="scroller" style={{ overflow: 'auto', height: 100 }}>
        <UserPicker value={null} onChange={vi.fn()} organizationId="org-1" multiple />
      </div>,
    );
    await userEvent.click(screen.getByPlaceholderText(/enter name or email/i));
    const item = await screen.findByText('Bragg, Coady');
    const scroller = screen.getByTestId('scroller');
    expect(scroller.contains(item)).toBe(false);
    expect(document.body.contains(item)).toBe(true);
  });

  // The portal puts the list outside the picker's own element, so the outside-click handler has
  // to treat it as inside — otherwise the click that chooses someone closes the list first and
  // the pick never lands.
  it('still registers a pick even though the list is portalled', async () => {
    const onChange = await openList();
    await userEvent.click(screen.getByText('Hite, Connor'));
    expect(onChange).toHaveBeenCalledWith(['u2']);
  });

});
