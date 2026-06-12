import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { createSpace, createPage, updatePage, transitionPage, getPage, search } from '../../src/modules/kb.js';
import type { Principal } from '../../src/types.js';

async function principalByEmail(email: string): Promise<Principal> {
  const u = await withSystemContext(async (sql) =>
    (await sql.query('SELECT id, plane, email, organization_id FROM users WHERE email=$1', [email])).rows[0],
  );
  return loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
}

describeDb('knowledge base (integration)', () => {
  let author: Principal; // SecurityAnalyst: kb.author + kb.publish

  beforeAll(async () => {
    author = await principalByEmail('analyst@nexus.example.com');
  });

  it('seeded global pages are full-text searchable', async () => {
    const hits = await search(author, 'password reset');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toHaveProperty('snippet');
  });

  it('create -> edit (versions) -> publish lifecycle works and is searchable once published', async () => {
    // A unique token per run keeps this idempotent against accumulated test data: the
    // published page is then the sole full-text match for the token.
    const token = `samlsso${Date.now()}`;
    const space = await createSpace(author, { key: `T${Date.now() % 100000}`, name: 'Test Space' });
    const page = await createPage(author, { spaceId: space.id, title: `Configuring ${token}`, body: `Initial draft about ${token}.` });
    expect(page.version).toBe(1);
    expect(page.status).toBe('draft');

    // draft is not in search results
    const beforePub = await search(author, token);
    expect(beforePub.find((h: any) => h.id === page.id)).toBeFalsy();

    const edited = await updatePage(author, page.id, { body: `Updated ${token} setup with metadata exchange.` });
    expect(edited.version).toBe(2);

    await transitionPage(author, page.id, 'published');
    const full = await getPage(author, page.id);
    expect(full.status).toBe('published');

    const afterPub = await search(author, token);
    expect(afterPub.find((h: any) => h.id === page.id)).toBeTruthy();
  });
});
