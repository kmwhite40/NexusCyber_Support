import { it, expect, beforeAll } from 'vitest';
import { describeDb } from '../helpers/db.js';
import { withSystemContext } from '../../src/db/pool.js';
import { loadPrincipal } from '../../src/auth/principal.js';
import { upload, download, listForTicket } from '../../src/modules/attachments.js';
import type { Principal } from '../../src/types.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describeDb('attachments (integration)', () => {
  let agent: Principal;
  let ticketId: string;

  beforeAll(async () => {
    const u = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id, plane, email, organization_id FROM users WHERE email='agent@nexus.example.com'")).rows[0],
    );
    agent = await loadPrincipal({ sub: u.id, plane: u.plane, email: u.email, org: u.organization_id, roles: [] });
    ticketId = await withSystemContext(async (sql) =>
      (await sql.query("SELECT id FROM tickets WHERE ticket_number='ACME-000001'")).rows[0].id,
    );
  });

  it('uploads a clean file and serves it', async () => {
    const att = await upload(agent, { ticketId, filename: 'note.txt', contentType: 'text/plain', bytes: Buffer.from('hello') });
    expect(att.scan_status).toBe('clean');
    const list = await listForTicket(agent, ticketId);
    expect(list.find((a: any) => a.id === att.id)).toBeTruthy();
    const dl = await download(agent, att.id);
    expect(dl.bytes.toString()).toBe('hello');
  });

  it('stores an infected file but blocks download', async () => {
    const att = await upload(agent, { ticketId, filename: 'virus.txt', contentType: 'text/plain', bytes: Buffer.from(EICAR) });
    expect(att.scan_status).toBe('infected');
    await expect(download(agent, att.id)).rejects.toThrow(/infected/i);
  });
});
