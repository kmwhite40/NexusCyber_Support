// How people are named on the ticket detail page: comment authors, timeline actors, and the
// assignee line in Details. The API sends display names only (never emails) on both planes.
import type { Ticket, TicketComment, UserName } from './api';

/**
 * The label for one person. A null person, or one with a null id, is a system/automation write.
 * `you` is how the viewer is named — 'You' as a heading, 'you' mid-sentence ("assigned by you").
 */
export function personLabel(
  p: { id: string | null; name: string | null } | null | undefined,
  meId: string | undefined,
  you = 'You',
): string {
  if (!p || !p.id) return 'System';
  if (meId && p.id === meId) return you;
  return p.name ?? 'Unknown user';
}

/** A comment's author. Falls back to author_id so the viewer still sees 'You' without names. */
export function commentAuthorLabel(c: TicketComment, meId: string | undefined): string {
  const author: UserName | null = c.author ?? (c.author_id ? { id: c.author_id, name: null } : null);
  return personLabel(author, meId);
}

/** Details > Assignee: "Name · assigned by X, <time>", "Name", or "Unassigned". */
export function assigneeSummary(t: Pick<Ticket, 'assignee' | 'assigned_by'>, meId: string | undefined): string {
  if (!t.assignee) return 'Unassigned';
  const name = personLabel(t.assignee, meId);
  if (!t.assigned_by) return name;
  return `${name} · assigned by ${personLabel(t.assigned_by, meId, 'you')}, ${new Date(t.assigned_by.at).toLocaleString()}`;
}
