// Ticket attachments: validate -> store -> scan -> serve (org-scoped streaming).
// Infected files are recorded but never served (docs/nexus/08 §Q.3, US-013).
import { createHash, randomUUID } from 'node:crypto';
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import { blobStore, scanner, validateUpload } from './storage.js';
import type { Principal } from '../types.js';

export interface UploadInput {
  ticketId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  commentId?: string | null;
}

export async function upload(actor: Principal, input: UploadInput) {
  const check = validateUpload({ contentType: input.contentType, size: input.bytes.length });
  if (!check.ok) throw Errors.validation(check.reason);

  return withOrgContext(orgContextFor(actor), async (sql) => {
    const t = (await sql.query('SELECT id, organization_id FROM tickets WHERE id=$1', [input.ticketId])).rows[0];
    if (!t) throw Errors.notFound('ticket not found');
    authorize(actor, 'ticket.comment', { organizationId: t.organization_id });

    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = `${t.organization_id}/${input.ticketId}/${randomUUID()}`;
    await blobStore.put(storageKey, input.bytes);
    const scanStatus = await scanner.scan(input.bytes);

    const { rows } = await sql.query(
      `INSERT INTO attachments
         (organization_id, ticket_id, comment_id, filename, content_type, size_bytes, sha256, scan_status, storage_key, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, filename, content_type, size_bytes, scan_status, created_at`,
      [t.organization_id, input.ticketId, input.commentId ?? null, input.filename, input.contentType, input.bytes.length, sha256, scanStatus, storageKey, actor.id],
    );
    const att = rows[0];
    await audit(actor, { action: 'attachment.upload', organizationId: t.organization_id, resourceType: 'attachment', resourceId: att.id, detail: { scan_status: scanStatus, sha256 } });
    return att;
  });
}

export async function listForTicket(actor: Principal, ticketId: string) {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const { rows } = await sql.query(
      `SELECT id, filename, content_type, size_bytes, scan_status, created_at
         FROM attachments WHERE ticket_id=$1 ORDER BY created_at DESC`,
      [ticketId],
    );
    return rows;
  });
}

export interface DownloadResult {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Org-scoped streaming download. Infected (or not-yet-clean) files are never served. */
export async function download(actor: Principal, attachmentId: string): Promise<DownloadResult> {
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const a = (await sql.query('SELECT * FROM attachments WHERE id=$1', [attachmentId])).rows[0];
    if (!a) throw Errors.notFound('attachment not found'); // RLS already scopes by org
    authorize(actor, 'ticket.comment', { organizationId: a.organization_id });
    if (a.scan_status !== 'clean') throw Errors.forbidden(`attachment is ${a.scan_status}; download blocked`);
    const bytes = await blobStore.get(a.storage_key);
    await audit(actor, { action: 'attachment.download', organizationId: a.organization_id, resourceType: 'attachment', resourceId: a.id });
    return { filename: a.filename, contentType: a.content_type, bytes };
  });
}
