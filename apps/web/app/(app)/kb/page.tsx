'use client';
import * as React from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody, Button, Badge, Input } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';

interface Space { id: string; key: string; name: string; description?: string; page_count: number }
interface TreeNode { id: string; parent_id: string | null; title: string; status: string; children: TreeNode[] }
interface Page {
  id: string; title: string; body: string; status: string; version: number; labels: string[];
  updated_at: string; children: Array<{ id: string; title: string; status: string }>;
  comments: Array<{ id: string; author_id: string | null; body: string; created_at: string }>;
}
interface Hit { id: string; title: string; snippet: string }

// Minimal, dependency-free markdown-ish rendering (headings, bullets, paragraphs).
function renderBody(body: string): React.ReactNode {
  return body.split('\n').map((line, i) => {
    if (line.startsWith('# ')) return <h2 key={i} className="mt-4 text-xl font-semibold text-fg">{line.slice(2)}</h2>;
    if (line.startsWith('## ')) return <h3 key={i} className="mt-3 text-lg font-semibold text-fg">{line.slice(3)}</h3>;
    if (/^\d+\.\s/.test(line)) return <li key={i} className="ml-5 list-decimal text-sm text-fg/90">{line.replace(/^\d+\.\s/, '')}</li>;
    if (line.startsWith('- ')) return <li key={i} className="ml-5 list-disc text-sm text-fg/90">{line.slice(2)}</li>;
    if (!line.trim()) return <div key={i} className="h-2" />;
    return <p key={i} className="text-sm leading-relaxed text-fg/90">{line}</p>;
  });
}

export default function KbPage() {
  const { can } = useAuth();
  const [spaces, setSpaces] = React.useState<Space[] | null>(null);
  const [spaceId, setSpaceId] = React.useState<string | null>(null);
  const [tree, setTree] = React.useState<TreeNode[]>([]);
  const [page, setPage] = React.useState<Page | null>(null);
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<Hit[] | null>(null);
  const [comment, setComment] = React.useState('');
  const [editing, setEditing] = React.useState<{ title: string; body: string } | null>(null);

  const canAuthor = can('kb.author');
  const canPublish = can('kb.publish');

  React.useEffect(() => {
    api.get<{ data: Space[] }>('/kb/spaces').then((r) => {
      setSpaces(r.data);
      if (r.data[0]) setSpaceId(r.data[0].id);
    }).catch(() => setSpaces([]));
  }, []);

  const loadTree = React.useCallback((sid: string) => {
    api.get<{ data: TreeNode[] }>(`/kb/spaces/${sid}/tree`).then((r) => setTree(r.data)).catch(() => setTree([]));
  }, []);
  React.useEffect(() => { if (spaceId) loadTree(spaceId); }, [spaceId, loadTree]);

  const openPage = React.useCallback((id: string) => {
    setEditing(null);
    api.get<Page>(`/kb/pages/${id}`).then(setPage).catch(() => {});
  }, []);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) { setHits(null); return; }
    const r = await api.get<{ data: Hit[] }>(`/kb/search?q=${encodeURIComponent(query)}`);
    setHits(r.data);
  }

  async function addComment() {
    if (!page || !comment.trim()) return;
    await api.post(`/kb/pages/${page.id}/comments`, { body: comment });
    setComment('');
    openPage(page.id);
  }

  async function transition(to: string) {
    if (!page) return;
    await api.post(`/kb/pages/${page.id}/transition`, { to });
    openPage(page.id);
    if (spaceId) loadTree(spaceId);
  }

  async function saveEdit() {
    if (!page || !editing) return;
    await api.patch(`/kb/pages/${page.id}`, { title: editing.title, body: editing.body });
    setEditing(null);
    openPage(page.id);
    if (spaceId) loadTree(spaceId);
  }

  async function newPage() {
    if (!spaceId) return;
    const created = await api.post<{ id: string }>('/kb/pages', { spaceId, title: 'Untitled page', body: '# Untitled\n\nStart writing…' });
    if (spaceId) loadTree(spaceId);
    openPage(created.id);
  }

  function Tree({ nodes }: { nodes: TreeNode[] }) {
    return (
      <ul className="space-y-0.5">
        {nodes.map((n) => (
          <li key={n.id}>
            <button
              onClick={() => openPage(n.id)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-2 ${page?.id === n.id ? 'bg-brand/10 text-brand' : 'text-fg/90'}`}
            >
              <span className="truncate">{n.title}</span>
              {n.status !== 'published' && <Badge tone="neutral" className="ml-auto text-[9px]">{n.status}</Badge>}
            </button>
            {n.children.length > 0 && <div className="ml-3 border-l border-border pl-1"><Tree nodes={n.children} /></div>}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
          <p className="mt-1 text-sm text-muted">Self-service articles, runbooks, and how-tos.</p>
        </div>
        <form onSubmit={runSearch} className="flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search articles…" className="w-64" />
          <Button type="submit" variant="outline">Search</Button>
        </form>
      </div>

      {hits && (
        <Card>
          <CardBody>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-fg">{hits.length} result{hits.length === 1 ? '' : 's'} for “{query}”</span>
              <button className="text-xs text-muted hover:text-fg" onClick={() => setHits(null)}>Clear</button>
            </div>
            {hits.length === 0 ? (
              <EmptyState title="No matches" description="Try different keywords." />
            ) : (
              <ul className="space-y-2">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button onClick={() => { openPage(h.id); setHits(null); }} className="block w-full rounded-md border border-border p-3 text-left hover:bg-surface-2">
                      <div className="text-sm font-medium text-brand">{h.title}</div>
                      <div className="mt-0.5 text-xs text-muted" dangerouslySetInnerHTML={{ __html: h.snippet }} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        {/* Spaces + tree */}
        <div className="space-y-3">
          <Card>
            <CardBody className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Spaces</div>
              {!spaces ? <Skeleton className="h-8" /> : spaces.map((s) => (
                <button key={s.id} onClick={() => { setSpaceId(s.id); setPage(null); }} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-surface-2 ${spaceId === s.id ? 'bg-brand/10 text-brand' : 'text-fg/90'}`}>
                  <span className="truncate">{s.name}</span>
                  <Badge tone="neutral" className="text-[9px]">{s.page_count}</Badge>
                </button>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Pages</div>
                {canAuthor && spaceId && <button onClick={newPage} className="text-xs text-brand hover:underline">+ New</button>}
              </div>
              {tree.length === 0 ? <p className="text-xs text-muted">No pages yet.</p> : <Tree nodes={tree} />}
            </CardBody>
          </Card>
        </div>

        {/* Page view */}
        <Card>
          <CardBody>
            {!page ? (
              <EmptyState title="Select an article" description="Choose a page from the tree or search above." />
            ) : editing ? (
              <div className="space-y-3">
                <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className="text-lg font-semibold" />
                <textarea
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  rows={18}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-fg"
                />
                <div className="flex gap-2">
                  <Button onClick={saveEdit}>Save</Button>
                  <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold text-fg">{page.title}</h2>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <Badge tone={page.status === 'published' ? 'success' : 'neutral'}>{page.status}</Badge>
                      <span>v{page.version}</span>
                      <span>· updated {new Date(page.updated_at).toLocaleDateString()}</span>
                      {page.labels.map((l) => <Badge key={l} tone="brand" className="text-[9px]">{l}</Badge>)}
                    </div>
                  </div>
                  {canAuthor && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing({ title: page.title, body: page.body })}>Edit</Button>
                      {canPublish && page.status === 'draft' && <Button size="sm" onClick={() => transition('published')}>Publish</Button>}
                      {canPublish && page.status === 'published' && <Button size="sm" variant="outline" onClick={() => transition('archived')}>Archive</Button>}
                    </div>
                  )}
                </div>
                <div className="prose-nexus space-y-1 border-t border-border pt-4">{renderBody(page.body)}</div>

                {/* Comments */}
                <div className="border-t border-border pt-4">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Comments ({page.comments.length})</div>
                  <div className="space-y-2">
                    {page.comments.map((c) => (
                      <div key={c.id} className="rounded-md border border-border bg-surface-2/40 px-3 py-2 text-sm text-fg/90">
                        {c.body}
                        <div className="mt-0.5 text-[10px] text-muted">{new Date(c.created_at).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" />
                    <Button variant="outline" onClick={addComment}>Comment</Button>
                  </div>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
