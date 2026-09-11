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

// "Almost like it can't find the requestor name." When the search returned nothing the component
// rendered NOTHING — `{open && hits.length > 0 && ...}` — so "no matches" and "not searched yet"
// looked identical. An operator typed a name, saw no list, and reasonably concluded the picker was
// broken; the typed text then sat in the box looking like a value while the field stayed empty.
describe('user picker feedback when nothing matches', () => {
  it('says so instead of rendering nothing', async () => {
    const { users } = await import('@/lib/api');
    (users.search as any).mockResolvedValueOnce({ data: [] });
    render(<UserPicker value={null} onChange={vi.fn()} organizationId="org-1" />);
    await userEvent.type(screen.getByPlaceholderText(/enter name or email/i), 'nobody');
    expect(await screen.findByText(/no (one|matches)/i)).toBeTruthy();
  });

  it('warns that typed text is not a selection', async () => {
    const { users } = await import('@/lib/api');
    (users.search as any).mockResolvedValueOnce({ data: [] });
    render(<UserPicker value={null} onChange={vi.fn()} organizationId="org-1" />);
    await userEvent.type(screen.getByPlaceholderText(/enter name or email/i), 'kevin.white@sbsfederal.com');
    expect(await screen.findByText(/choose|select|pick/i)).toBeTruthy();
  });
});

// The requester box showed a full email address and the field was still empty: typing is not
// selecting, and nothing on screen said so while results existed. The "no matches" hint only
// appeared when the search came back EMPTY — exactly the case where a real name IS found, typed
// in full, and left unselected, the operator got no warning at all.
describe('typed text is not a selection', () => {
  it('warns whenever text is typed and nobody is selected, even when matches exist', async () => {
    const { users } = await import('@/lib/api');
    (users.search as any).mockResolvedValue({
      data: [{ id: 'u1', display_name: 'Bragg, Coady', email: 'coady.bragg@sbsfederal.com' }],
    });
    render(<UserPicker value={null} onChange={vi.fn()} organizationId="org-1" />);
    await userEvent.type(screen.getByPlaceholderText(/enter name or email/i), 'coady');
    // The warning is what matters: a search that FINDS someone must still say nobody is
    // selected. Dropdown rendering is covered by the portal tests above.
    expect(await screen.findByText(/not selected/i)).toBeTruthy();
    expect((users.search as any)).toHaveBeenCalled();
  });

  // The warning is keyed on whether anyone is SELECTED, not on whether the box has text — so a
  // picker holding a real selection stays quiet. Selection itself is covered by the portal tests.
  it('stays quiet when someone is actually selected', async () => {
    render(<UserPicker value={'u1'} onChange={vi.fn()} organizationId="org-1" />);
    await userEvent.type(screen.getByPlaceholderText(/enter name or email/i), 'coady');
    expect(screen.queryByText(/not selected/i)).toBeNull();
  });
});
