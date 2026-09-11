import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StarRating } from '@/components/star-rating';

// The survey is answered by people who are not signed in, often on a phone, once. Whatever this
// control does has to be obvious and reachable without a mouse.
describe('StarRating', () => {
  it('reports the star that was chosen', async () => {
    const onChange = vi.fn();
    render(<StarRating label="Overall" value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: /4 out of 5/i }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('offers exactly five', () => {
    render(<StarRating label="Overall" value={null} onChange={vi.fn()} />);
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  // A rating control that only works by mouse excludes people, and this one is behind no login,
  // so there is no admin to do it for them.
  it('is a labelled radio group, so it works from the keyboard and reads to a screen reader', () => {
    render(<StarRating label="Overall satisfaction" value={3} onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: /overall satisfaction/i });
    expect(group).toBeTruthy();
    expect(screen.getByRole('radio', { name: /3 out of 5/i }).getAttribute('aria-checked')).toBe('true');
  });

  // Colour alone cannot carry the value: a filled star and an empty one must differ to someone
  // who cannot tell them apart by hue.
  it('states the current value in words rather than only in colour', () => {
    render(<StarRating label="Overall" value={2} onChange={vi.fn()} />);
    expect(screen.getByText(/2 out of 5/i)).toBeTruthy();
  });

  it('says nothing is chosen yet when nothing is', () => {
    render(<StarRating label="Overall" value={null} onChange={vi.fn()} />);
    expect(screen.getByText(/not rated yet/i)).toBeTruthy();
  });
});
