import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TicketComments } from '@/components/ticket-conversation';
import { assigneeSummary, personLabel } from '@/lib/ticket-people';
import type { TicketComment } from '@/lib/api';

// The conversation used to label every comment "You", "Agent (internal)" or "Participant" — so the
// desk could not tell which colleague wrote an internal note, and a customer could not tell who
// was answering them. The API now returns each comment's author by display name (never email),
// and the ticket's assignee plus who assigned them.
const ME = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';

function comment(over: Partial<TicketComment>): TicketComment {
  return { id: over.id ?? 'c', body: 'hello', visibility: 'customer', created_at: '2026-10-01T10:00:00.000Z', author_id: AGENT, ...over };
}

describe('TicketComments author labels', () => {
  it("names the author instead of 'Participant' / 'Agent (internal)'", () => {
    render(
      <TicketComments
        meId={ME}
        comments={[
          comment({ id: 'reply', body: 'Looking into it', author: { id: AGENT, name: 'Avery Agent' } }),
          comment({ id: 'note', body: 'MDM suspect', visibility: 'internal', author: { id: AGENT, name: 'Avery Agent' } }),
        ]}
      />,
    );
    expect(screen.getAllByText('Avery Agent')).toHaveLength(2);
    expect(screen.queryByText('Participant')).toBeNull();
    expect(screen.queryByText('Agent (internal)')).toBeNull();
  });

  it('keeps the internal-note badge on internal notes only', () => {
    render(
      <TicketComments
        meId={ME}
        comments={[
          comment({ id: 'reply', body: 'Looking into it', author: { id: AGENT, name: 'Avery Agent' } }),
          comment({ id: 'note', body: 'MDM suspect', visibility: 'internal', author: { id: AGENT, name: 'Avery Agent' } }),
        ]}
      />,
    );
    const note = screen.getByText('MDM suspect').closest('[data-comment]') as HTMLElement;
    const reply = screen.getByText('Looking into it').closest('[data-comment]') as HTMLElement;
    expect(within(note).getByText('internal note')).toBeInTheDocument();
    expect(within(reply).queryByText('internal note')).toBeNull();
  });

  it("says 'You' for the viewer's own comments", () => {
    render(<TicketComments meId={ME} comments={[comment({ author_id: ME, author: { id: ME, name: 'Me Myself' } })]} />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('Me Myself')).toBeNull();
  });

  it("says 'System' for an automation comment with no author", () => {
    render(<TicketComments meId={ME} comments={[comment({ author_id: null, author: null })]} />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('falls back to a neutral label when a real author has no display name', () => {
    render(<TicketComments meId={ME} comments={[comment({ author: { id: AGENT, name: null } })]} />);
    expect(screen.getByText('Unknown user')).toBeInTheDocument();
  });

  it('says so when there are no comments', () => {
    render(<TicketComments meId={ME} comments={[]} />);
    expect(screen.getByText('No comments yet.')).toBeInTheDocument();
  });
});

describe('personLabel', () => {
  it('lets the caller choose how the viewer is named mid-sentence', () => {
    expect(personLabel({ id: ME, name: 'x' }, ME, 'you')).toBe('you');
    expect(personLabel({ id: AGENT, name: 'Avery Agent' }, ME)).toBe('Avery Agent');
    expect(personLabel(null, ME)).toBe('System');
    expect(personLabel({ id: null, name: null }, ME)).toBe('System');
  });
});

describe('assigneeSummary (Details > Assignee)', () => {
  const at = '2026-10-01T10:00:00.000Z';

  it('names the assignee and who assigned them, with the time in the page format', () => {
    const s = assigneeSummary(
      { assignee: { id: AGENT, name: 'Blake Agent' }, assigned_by: { id: 'm', name: 'Morgan Manager', at } },
      ME,
    );
    expect(s).toBe(`Blake Agent · assigned by Morgan Manager, ${new Date(at).toLocaleString()}`);
  });

  it("says 'you' when the viewer did the assigning", () => {
    const s = assigneeSummary({ assignee: { id: AGENT, name: 'Blake Agent' }, assigned_by: { id: ME, name: 'Me', at } }, ME);
    expect(s).toBe(`Blake Agent · assigned by you, ${new Date(at).toLocaleString()}`);
  });

  it('credits automation as System', () => {
    const s = assigneeSummary({ assignee: { id: AGENT, name: 'Blake Agent' }, assigned_by: { id: null, name: null, at } }, ME);
    expect(s).toBe(`Blake Agent · assigned by System, ${new Date(at).toLocaleString()}`);
  });

  it('shows just the name when there is no assignment event to credit', () => {
    expect(assigneeSummary({ assignee: { id: AGENT, name: 'Blake Agent' }, assigned_by: null }, ME)).toBe('Blake Agent');
  });

  it("is 'Unassigned' with no assignee, even after an escalation cleared the owner", () => {
    expect(assigneeSummary({ assignee: null, assigned_by: { id: AGENT, name: 'Avery Agent', at } }, ME)).toBe('Unassigned');
    expect(assigneeSummary({}, ME)).toBe('Unassigned');
  });
});
