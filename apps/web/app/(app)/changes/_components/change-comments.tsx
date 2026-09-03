'use client';
// Deliberation thread for a change (GET/POST /changes/:id/comments). The API opens it to
// change raisers and board voters alike — the board argues here before it votes, so the
// thread is read-only rather than hidden when the viewer may not post.
import * as React from 'react';
import { Button, Textarea } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { changesApi, type ChangeComment } from '@/lib/changes';

export function ChangeComments({ changeId, canPost }: { changeId: string; canPost: boolean }) {
  const [items, setItems] = React.useState<ChangeComment[] | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    changesApi.comments(changeId).then(setItems).catch(() => setItems([]));
  }, [changeId]);
  React.useEffect(load, [load]);

  async function post() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    try {
      await changesApi.addComment(changeId, body);
      setDraft('');
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.detail : 'Failed to post your comment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Deliberation" className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Deliberation</div>
      {items === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted">No comments yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id} className="rounded-md border border-border p-2">
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
                <span className="font-medium text-fg">{c.author_name ?? 'Unknown author'}</span>
                <span>{new Date(c.created_at).toLocaleString()}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs text-fg/80">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {canPost && (
        <div className="space-y-2">
          <Textarea
            aria-label="Add a comment"
            placeholder="Add to the deliberation…"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button size="sm" variant="subtle" disabled={busy || !draft.trim()} onClick={post}>
            {busy ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      )}
      {err && <p className="text-xs text-danger">{err}</p>}
    </section>
  );
}
