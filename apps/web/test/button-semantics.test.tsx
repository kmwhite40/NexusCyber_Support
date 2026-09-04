import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/primitives';

// A design critique found danger red doing two different jobs. It sat on "Page on-call" — urgent
// but entirely safe, nobody loses anything — while the offboarding button that ARMS an account
// teardown had no variant at all, looking identical to "Send". The irreversible action was
// under-weighted and a safe one over-weighted, which trains exactly the wrong reflex around red
// in a product that disables accounts and strips licences.
describe('Button intent variants', () => {
  it('offers a distinct urgent treatment that is not danger', () => {
    render(
      <>
        <Button variant="warning">Page on-call</Button>
        <Button variant="danger">Delete org</Button>
      </>,
    );
    const urgent = screen.getByRole('button', { name: 'Page on-call' }).className;
    const destructive = screen.getByRole('button', { name: 'Delete org' }).className;
    expect(urgent).toContain('bg-warning');
    expect(destructive).toContain('bg-danger');
    expect(urgent).not.toBe(destructive);
  });

  // Warning is an amber fill; white text on amber routinely fails contrast, so it carries dark
  // ink deliberately rather than inheriting the danger button's white.
  it('keeps readable ink on the amber fill', () => {
    render(<Button variant="warning">Page</Button>);
    expect(screen.getByRole('button').className).toMatch(/text-(black|fg|\[.*\])/);
  });
});
