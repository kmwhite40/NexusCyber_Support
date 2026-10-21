// Display names for user ids, resolved in system context.
//
// A LEFT JOIN on users inside a request's org context cannot be trusted for this: RLS on `users`
// hides the org-NULL rows that Nexus agents live in, so the join quietly returns NULL names for
// exactly the staff a customer-org ticket or change thread is full of. Resolving outside tenant
// RLS is safe ONLY because every caller has already passed its own access check on the record the
// ids came from, and because this returns the display name and nothing else — never an email.
import { withSystemContext } from '../db/pool.js';

export interface UserName { id: string; name: string | null }

/** id -> display_name for every id given. Ids with no users row are absent from the map. */
export async function resolveUserNames(ids: Iterable<string | null | undefined>): Promise<Map<string, string | null>> {
  const unique = [...new Set([...ids].filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await withSystemContext(async (s) =>
    (await s.query('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [unique])).rows,
  );
  return new Map(rows.map((r: { id: string; display_name: string | null }) => [r.id, r.display_name]));
}

/** `{ id, name }` for one id, or null when there is no id (a system/automation write). */
export function nameRef(names: ReadonlyMap<string, string | null>, id: string | null | undefined): UserName | null {
  if (!id) return null;
  return { id, name: names.get(id) ?? null };
}
