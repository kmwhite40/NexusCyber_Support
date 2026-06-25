// Virtual agent / assisted intake (ServiceNow parity Phase 4).
//
// A RETRIEVAL-GROUNDED self-service assistant: given a natural-language question it
// returns the best knowledge-base answer, related articles, and matching catalog actions,
// and flags when nothing was found so the portal can deflect to a ticket. It deliberately
// uses only in-boundary data (KB full-text + catalog), NOT an external LLM — the gov
// enclave disables AI egress (cloud_environments.capability_matrix ai='disabled'). When an
// AI capability is later enabled, an answer-synthesis step can layer on top of this.
import { search as kbSearch } from './kb.js';
import { withSystemContext } from '../db/pool.js';
import type { Principal } from '../types.js';

export interface AssistResult {
  query: string;
  answer: { id: string; title: string; snippet: string } | null;
  articles: Array<{ id: string; title: string; snippet: string }>;
  services: Array<{ key: string; name: string; category: string }>;
  deflect: boolean;
}

export async function assist(actor: Principal, query: string): Promise<AssistResult> {
  const q = query.trim();
  if (!q) return { query: q, answer: null, articles: [], services: [], deflect: false };

  // 1) Knowledge base (full-text, RLS-scoped).
  const kb = (await kbSearch(actor, q, 4).catch(() => [])) as Array<{ id: string; title: string; snippet: string }>;

  // 2) Catalog actions: match significant query tokens against name/category/description.
  const tokens = [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))].slice(0, 6);
  let services: AssistResult['services'] = [];
  if (tokens.length) {
    services = await withSystemContext(async (sql) => {
      const clauses = tokens.map((_, i) => `(name ILIKE $${i + 1} OR category ILIKE $${i + 1} OR description ILIKE $${i + 1})`);
      const { rows } = await sql.query(
        `SELECT key, name, category FROM service_catalog_items
          WHERE ${clauses.join(' OR ')}
          ORDER BY name LIMIT 4`,
        tokens.map((t) => `%${t}%`),
      );
      return rows as AssistResult['services'];
    });
  }

  return {
    query: q,
    answer: kb[0] ? { id: kb[0].id, title: kb[0].title, snippet: kb[0].snippet } : null,
    articles: kb,
    services,
    deflect: kb.length === 0,
  };
}
