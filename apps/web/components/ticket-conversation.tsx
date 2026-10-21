'use client';
import * as React from 'react';
import { Badge } from '@/components/ui/primitives';
import type { TicketComment } from '@/lib/api';
import { commentAuthorLabel } from '@/lib/ticket-people';

/** The ticket's comment thread, each comment headed by its author's name. Serves both planes: the
 *  API has already withheld internal notes from customers. */
export function TicketComments({ comments, meId }: { comments: TicketComment[]; meId: string | undefined }) {
  if (comments.length === 0) return <p className="text-sm text-muted">No comments yet.</p>;
  return (
    <>
      {comments.map((c) => (
        <div key={c.id} data-comment className={`rounded-md border p-3 ${c.visibility === 'internal' ? 'border-warning/30 bg-warning/5' : 'border-border bg-surface-2/40'}`}>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium text-fg">{commentAuthorLabel(c, meId)}</span>
            {c.visibility === 'internal' && <Badge tone="warning">internal note</Badge>}
            <span className="ml-auto text-xs text-muted">{new Date(c.created_at).toLocaleString()}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-fg/90">{c.body}</p>
        </div>
      ))}
    </>
  );
}
