// Confluence-style knowledge base (docs/nexus/07 §N). Spaces contain a tree of pages;
// each edit snapshots an immutable version; pages have a draft->published->archived
// lifecycle, full-text search, footer comments, and feed ticket deflection.
//
// Reads run in the org context so RLS scopes them to global (NULL-org) + own-org rows.
// Writes run in the system context with an explicit organization_id, so Nexus agents can
// author GLOBAL content (org NULL) that every customer can read.
import { withOrgContext, withSystemContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';

export type PageStatus = 'draft' | 'published' | 'archived';

const TRANSITIONS: Record<PageStatus, PageStatus[]> = {
  draft: ['published', 'archived'],
  published: ['archived', 'draft'],
  archived: ['draft'],
};

/** Is a page lifecycle transition allowed? Pure. */
export function canTransition(from: PageStatus, to: PageStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface PageNode {
  id: string;
  parent_id: string | null;
  title: string;
  status: string;
  children: PageNode[];
  [k: string]: unknown;
}

/** Nest a flat page list into a parent/child tree (roots first). Pure. */
export function buildPageTree<T extends { id: string; parent_id: string | null }>(pages: T[]): Array<T & { children: any[] }> {
  const byId = new Map<string, T & { children: any[] }>();
  for (const p of pages) byId.set(p.id, { ...p, children: [] });
  const roots: Array<T & { children: any[] }> = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The org a write is scoped to: a customer's own org, or NULL (global) for Nexus agents. */
function authorOrg(actor: Principal): string | null {
  return actor.plane === 'customer' ? actor.organizationId : null;
}

export async function listSpaces(actor: Principal) {
  authorize(actor, 'kb.read');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT s.id, s.organization_id, s.key, s.name, s.description,
              (SELECT count(*)::int FROM kb_pages p WHERE p.space_id = s.id) AS page_count
         FROM kb_spaces s ORDER BY s.name`,
    );
    return rows;
  });
}

export async function createSpace(actor: Principal, input: { key: string; name: string; description?: string }) {
  authorize(actor, 'kb.author');
  const orgId = authorOrg(actor);
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO kb_spaces (organization_id, key, name, description, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, input.key, input.name, input.description ?? null, actor.id],
    );
    const space = rows[0];
    await audit(actor, { action: 'kb.space.create', organizationId: orgId, resourceType: 'kb_space', resourceId: space.id, detail: { key: input.key } });
    return space;
  });
}

export interface CreatePageInput {
  spaceId: string;
  parentId?: string | null;
  title: string;
  body?: string;
  labels?: string[];
}

export async function createPage(actor: Principal, input: CreatePageInput) {
  authorize(actor, 'kb.author');
  const orgId = authorOrg(actor);
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO kb_pages (organization_id, space_id, parent_id, title, body, labels, author_id, updated_by, version, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,1,'draft') RETURNING *`,
      [orgId, input.spaceId, input.parentId ?? null, input.title, input.body ?? '', input.labels ?? [], actor.id],
    );
    const page = rows[0];
    await sql.query(
      `INSERT INTO kb_page_versions (page_id, version, title, body, edited_by) VALUES ($1,1,$2,$3,$4)`,
      [page.id, input.title, input.body ?? '', actor.id],
    );
    await audit(actor, { action: 'kb.page.create', organizationId: orgId, resourceType: 'kb_page', resourceId: page.id, detail: { title: input.title } });
    return page;
  });
}

export interface UpdatePageInput {
  title?: string;
  body?: string;
  labels?: string[];
}

/** Edit a page: snapshots the prior version and bumps the version counter. */
export async function updatePage(actor: Principal, pageId: string, input: UpdatePageInput) {
  authorize(actor, 'kb.author');
  return withSystemContext(async (sql) => {
    const cur = (await sql.query('SELECT * FROM kb_pages WHERE id=$1', [pageId])).rows[0];
    if (!cur) throw Errors.notFound('page not found');
    const title = input.title ?? cur.title;
    const body = input.body ?? cur.body;
    const labels = input.labels ?? cur.labels;
    const nextVersion = cur.version + 1;
    // Snapshot the prior content before overwriting.
    await sql.query(
      `INSERT INTO kb_page_versions (page_id, version, title, body, edited_by) VALUES ($1,$2,$3,$4,$5)`,
      [pageId, nextVersion, title, body, actor.id],
    );
    const { rows } = await sql.query(
      `UPDATE kb_pages SET title=$1, body=$2, labels=$3, version=$4, updated_by=$5, updated_at=now()
        WHERE id=$6 RETURNING *`,
      [title, body, labels, nextVersion, actor.id, pageId],
    );
    await audit(actor, { action: 'kb.page.update', organizationId: cur.organization_id, resourceType: 'kb_page', resourceId: pageId, detail: { version: nextVersion } });
    return rows[0];
  });
}

/** Move a page through its lifecycle. Publishing requires kb.publish. */
export async function transitionPage(actor: Principal, pageId: string, to: PageStatus) {
  authorize(actor, to === 'published' ? 'kb.publish' : 'kb.author');
  return withSystemContext(async (sql) => {
    const cur = (await sql.query('SELECT * FROM kb_pages WHERE id=$1', [pageId])).rows[0];
    if (!cur) throw Errors.notFound('page not found');
    if (!canTransition(cur.status as PageStatus, to)) throw Errors.conflict(`cannot move page from ${cur.status} to ${to}`);
    const publishedAt = to === 'published' ? new Date().toISOString() : cur.published_at;
    await sql.query('UPDATE kb_pages SET status=$1, published_at=$2, updated_at=now() WHERE id=$3', [to, publishedAt, pageId]);
    await audit(actor, { action: `kb.page.${to}`, organizationId: cur.organization_id, resourceType: 'kb_page', resourceId: pageId });
    if (to === 'published') publish('kb.page_published', cur.organization_id, { page_id: pageId, title: cur.title });
    return { status: to };
  });
}

export async function getPage(actor: Principal, pageId: string) {
  authorize(actor, 'kb.read');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const page = (await sql.query('SELECT * FROM kb_pages WHERE id=$1', [pageId])).rows[0];
    if (!page) throw Errors.notFound('page not found');
    const children = (await sql.query("SELECT id, title, status FROM kb_pages WHERE parent_id=$1 ORDER BY title", [pageId])).rows;
    const comments = (
      await sql.query('SELECT id, author_id, body, created_at FROM kb_page_comments WHERE page_id=$1 ORDER BY created_at', [pageId])
    ).rows;
    return { ...page, children, comments };
  });
}

export async function spaceTree(actor: Principal, spaceId: string) {
  authorize(actor, 'kb.read');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, parent_id, title, status FROM kb_pages WHERE space_id=$1 ORDER BY title`,
      [spaceId],
    );
    return buildPageTree(rows as Array<{ id: string; parent_id: string | null; title: string; status: string }>);
  });
}

/** Full-text search over published pages (drafts are excluded from search). */

/**
 * Snippet highlighting, without trusting ts_headline to sanitize.
 *
 * The search snippet is rendered with dangerouslySetInnerHTML on three surfaces — the agent KB
 * page and two customer-facing portal views. ts_headline's default StartSel/StopSel are literal
 * `<b>` tags, which forces the renderer to accept HTML from page bodies. That looked safe because
 * ts_headline drops WELL-FORMED tags. It does not drop everything: an unclosed `<img src=x
 * onerror=...` and `<svg/onload=...>` both survive verbatim, so any kb.author could run script in
 * a reader's session, including an admin's and including another tenant's portal.
 *
 * So matches are marked with control characters instead — they cannot appear in page text and
 * carry no meaning in HTML — the whole string is escaped, and only then are the two <b> tags we
 * are willing to emit put back.
 */
export const SNIPPET_START = '\u0001';
export const SNIPPET_STOP = '\u0002';

/** ts_headline options carrying the sentinels. Passed as a bound parameter, never interpolated. */
export const SNIPPET_OPTS =
  `MaxFragments=1,MaxWords=24,MinWords=8,StartSel=${SNIPPET_START},StopSel=${SNIPPET_STOP}`;

export function renderSnippet(raw: string): string {
  const escaped = String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // Split/join rather than a global regex: the sentinels are literal single characters, and this
  // cannot be tricked by anything in the escaped text, which no longer contains them.
  return escaped.split(SNIPPET_START).join('<b>').split(SNIPPET_STOP).join('</b>');
}

export async function search(actor: Principal, q: string, limit = 20) {
  authorize(actor, 'kb.read');
  if (!q.trim()) return [];
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, space_id, title, status, ts_rank(tsv, websearch_to_tsquery('english', $1)) AS rank,
              ts_headline('english', body, websearch_to_tsquery('english', $1), $3) AS snippet
         FROM kb_pages
        WHERE status='published' AND tsv @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $2`,
      [q, limit, SNIPPET_OPTS],
    );
    // Escape here, at the single point every surface reads from, rather than in each of the
    // three components that render it.
    return rows.map((r: Record<string, unknown>) => ({ ...r, snippet: renderSnippet(String(r.snippet ?? '')) }));
  });
}

/**
 * Record per-article "did this resolve your issue?" feedback. resolved=true is a
 * deflection (the reader self-served); resolved=false means they went on to open a
 * ticket. Stored in kb_deflections for deflection-rate analytics. System context so
 * any reader (incl. nexus, who have no org) can record without RLS friction.
 */
export async function recordFeedback(actor: Principal, pageId: string, resolved: boolean) {
  authorize(actor, 'kb.read');
  return withSystemContext(async (sql) => {
    const page = (await sql.query('SELECT title FROM kb_pages WHERE id=$1', [pageId])).rows[0];
    if (!page) throw Errors.notFound('page not found');
    await sql.query(
      `INSERT INTO kb_deflections (organization_id, query, suggested_page_ids, deflected)
       VALUES ($1,$2,$3,$4)`,
      [actor.plane === 'customer' ? actor.organizationId : null, `article: ${page.title}`, [pageId], resolved],
    );
    return { recorded: true, resolved };
  });
}

export async function addComment(actor: Principal, pageId: string, body: string) {
  authorize(actor, 'kb.read');
  if (!body.trim()) throw Errors.badRequest('comment body required');
  const orgId = authorOrg(actor);
  return withSystemContext(async (sql) => {
    const page = (await sql.query('SELECT id, organization_id FROM kb_pages WHERE id=$1', [pageId])).rows[0];
    if (!page) throw Errors.notFound('page not found');
    const { rows } = await sql.query(
      `INSERT INTO kb_page_comments (organization_id, page_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING *`,
      [page.organization_id ?? orgId, pageId, actor.id, body],
    );
    await audit(actor, { action: 'kb.page.comment', organizationId: page.organization_id, resourceType: 'kb_page', resourceId: pageId });
    return rows[0];
  });
}

/** Suggest published pages for a free-text query (ticket deflection). */
export async function suggest(actor: Principal, text: string, limit = 5) {
  return search(actor, text, limit);
}

/** Record a deflection outcome (was a ticket avoided?). */
export async function logDeflection(actor: Principal, input: { query: string; suggestedPageIds: string[]; deflected: boolean }) {
  const orgId = actor.plane === 'customer' ? actor.organizationId : null;
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `INSERT INTO kb_deflections (organization_id, query, suggested_page_ids, deflected) VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, input.query, input.suggestedPageIds, input.deflected],
    );
    return { id: rows[0].id };
  });
}

export async function deflectionMetrics(actor: Principal) {
  authorize(actor, 'kb.read');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT count(*)::int AS suggestions,
              count(*) FILTER (WHERE deflected)::int AS deflected
         FROM kb_deflections`,
    );
    const r = rows[0];
    const rate = r.suggestions > 0 ? Math.round((r.deflected / r.suggestions) * 100) : 0;
    return { suggestions: r.suggestions, deflected: r.deflected, deflection_rate_pct: rate };
  });
}
