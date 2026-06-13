// Inbound mail -> ticket ingestion (docs/nexus/06 §L.4). Polls the service
// mailbox inbox via Graph delta queries (subscription-ready: a webhook can call
// the same ingestMessage). Sender domain maps to an org via organization_domains;
// unmatched senders are skipped. Dedupe + delta cursor live in integration_state.
import { logger } from '../../logger.js';
import type { Sql } from '../../db/pool.js';
import type { GraphClient } from './graph-client.js';
import { publish } from '../../events/bus.js';

const INTEGRATION = 'm365';
const DELTA_KEY = 'inbox_delta';

export interface InboundMessage {
  id: string;
  internetMessageId: string;
  fromAddress: string;
  subject: string;
  bodyPreview: string;
}

async function getState(sql: Sql, key: string): Promise<any | null> {
  const { rows } = await sql.query(
    'SELECT value FROM integration_state WHERE integration = $1 AND key = $2',
    [INTEGRATION, key],
  );
  return rows[0]?.value ?? null;
}

async function setState(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql.query(
    `INSERT INTO integration_state (integration, key, value, updated_at)
       VALUES ($1,$2,$3, now())
     ON CONFLICT (integration, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [INTEGRATION, key, JSON.stringify(value)],
  );
}

/** Poll the inbox delta; returns normalized new messages and stores the next deltaLink. */
export async function fetchNewMessages(
  sql: Sql,
  graphClient: GraphClient,
  mailbox: string,
): Promise<InboundMessage[]> {
  const stored = await getState(sql, DELTA_KEY);
  // First run (no cursor yet): establish the delta cursor against the CURRENT inbox
  // but do NOT ingest the existing backlog. Otherwise enabling ingestion would turn
  // every pre-existing email into a ticket and fire a no-reply acknowledgment to each
  // sender. Only mail that arrives after go-live is ingested on subsequent polls.
  const priming = !stored?.deltaLink;
  let url: string =
    stored?.deltaLink ??
    `/users/${mailbox}/mailFolders/inbox/messages/delta?$select=id,internetMessageId,subject,bodyPreview,from`;

  const messages: InboundMessage[] = [];
  // Follow nextLink pages until we reach the deltaLink.
  for (;;) {
    const page = await graphClient.get(url);
    if (!priming) {
      for (const m of page.value ?? []) {
        messages.push({
          id: m.id,
          internetMessageId: m.internetMessageId ?? m.id,
          fromAddress: m.from?.emailAddress?.address ?? '',
          subject: m.subject ?? '(no subject)',
          bodyPreview: m.bodyPreview ?? '',
        });
      }
    }
    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    if (page['@odata.deltaLink']) await setState(sql, DELTA_KEY, { deltaLink: page['@odata.deltaLink'] });
    break;
  }
  if (priming) logger.info({ mailbox }, 'mail ingest: primed delta cursor; existing inbox skipped (only new mail is ticketed)');
  return messages;
}

/** Create a ticket from one message. Idempotent by internetMessageId. */
export async function ingestMessage(
  sql: Sql,
  msg: InboundMessage,
): Promise<{ created: boolean; reason?: string; ticketId?: string }> {
  const seenKey = `seen:${msg.internetMessageId}`;
  if (await getState(sql, seenKey)) return { created: false, reason: 'duplicate' };

  const domain = msg.fromAddress.split('@')[1]?.toLowerCase() ?? '';
  const { rows: orgRows } = await sql.query(
    'SELECT organization_id FROM organization_domains WHERE domain = $1',
    [domain],
  );
  const orgId = orgRows[0]?.organization_id as string | undefined;
  if (!orgId) {
    logger.warn({ from: msg.fromAddress }, 'inbound mail: unmatched sender domain; skipping');
    await setState(sql, seenKey, true); // do not reprocess unmatched mail
    return { created: false, reason: 'unmatched-domain' };
  }

  // Generate a ticket number (mirrors modules/tickets.ts nextTicketNumber).
  const { rows: nRows } = await sql.query(
    `SELECT COALESCE(MAX((regexp_replace(ticket_number, '\\D','','g'))::int), 0) + 1 AS n
       FROM tickets WHERE organization_id = $1`,
    [orgId],
  );
  const { rows: pRows } = await sql.query(
    'SELECT left(upper(name),4) AS p FROM organizations WHERE id=$1',
    [orgId],
  );
  const ticketNumber = `${pRows[0].p}-${String(nRows[0].n).padStart(6, '0')}`;

  // Link the sender to an existing user in the org (best-effort) so they own the
  // ticket and can see it in the portal. The acknowledgment below still reaches the
  // raw address even when the sender has no account.
  const { rows: uRows } = await sql.query(
    'SELECT id FROM users WHERE organization_id = $1 AND lower(email) = lower($2) LIMIT 1',
    [orgId, msg.fromAddress],
  );
  const requesterId = (uRows[0]?.id as string | undefined) ?? null;

  const { rows: tRows } = await sql.query(
    `INSERT INTO tickets
       (organization_id, ticket_number, type, requester_id, source_channel, subject, description, status)
     VALUES ($1,$2,'incident',$3,'email',$4,$5,'new')
     RETURNING id`,
    [orgId, ticketNumber, requesterId, msg.subject, msg.bodyPreview],
  );
  const ticketId = tRows[0].id as string;

  await setState(sql, seenKey, true);
  logger.info({ ticketId, from: msg.fromAddress }, 'inbound mail -> ticket created');

  // Drive the standard notification pipeline — this path previously did a raw INSERT
  // and published nothing, so emailed tickets generated no notifications at all:
  //   ticket.created      -> service-desk "new ticket" email (from the no-reply mailbox)
  //   ticket.acknowledged -> automated confirmation to the customer who emailed in
  // Idempotency keys are derived from the message id so a re-poll never double-sends.
  publish(
    'ticket.created',
    orgId,
    {
      ticket_id: ticketId,
      org_id: orgId,
      type: 'incident',
      ticket_number: ticketNumber,
      subject: msg.subject,
      requester_id: requesterId,
      channel: 'email',
    },
    { idempotencyKey: `ticket.created:${msg.internetMessageId}` },
  );
  publish(
    'ticket.acknowledged',
    orgId,
    {
      ticket_id: ticketId,
      org_id: orgId,
      ticket_number: ticketNumber,
      subject: msg.subject,
      recipient_email: msg.fromAddress,
    },
    { idempotencyKey: `ticket.acknowledged:${msg.internetMessageId}` },
  );

  return { created: true, ticketId };
}
