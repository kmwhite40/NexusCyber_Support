// Inbound mail -> ticket ingestion (docs/nexus/06 §L.4). Polls the service
// mailbox inbox via Graph delta queries (subscription-ready: a webhook can call
// the same ingestMessage). Sender domain maps to an org via organization_domains;
// unmatched senders are skipped. Dedupe + delta cursor live in integration_state.
import { logger } from '../../logger.js';
import type { Sql } from '../../db/pool.js';
import type { GraphClient } from './graph-client.js';
import { publish } from '../../events/bus.js';
import { derivePriority, nextTicketNumber } from '../../modules/tickets.js';

const INTEGRATION = 'm365';
const DELTA_KEY = 'inbox_delta';

export interface InboundMessage {
  id: string;
  internetMessageId: string;
  fromAddress: string;
  fromName: string;
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
          fromName: m.from?.emailAddress?.name ?? '',
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

/** Pull a ticket number like ACME-000123 from a reply subject ("RE: [ACME-000123] …"). Pure. */
export function extractTicketNumber(subject: string): string | null {
  const m = (subject ?? '').match(/\b([A-Z][A-Z0-9]{1,5}-\d{4,8})\b/);
  return m ? m[1] : null;
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

  // Reply threading: if the subject carries an existing ticket number for this org,
  // append the message as a customer comment (and reopen if it was closed) instead of
  // opening a duplicate ticket. Outbound mail puts [TICKET-NUM] in the subject, which
  // mail clients quote on reply, so this catches the common "RE: [NUM] …" case.
  const replyNum = extractTicketNumber(msg.subject);
  if (replyNum) {
    const { rows: exist } = await sql.query(
      'SELECT id, status, assigned_agent_id FROM tickets WHERE organization_id=$1 AND ticket_number=$2 LIMIT 1',
      [orgId, replyNum],
    );
    const ticket = exist[0];
    if (ticket) {
      const { rows: u } = await sql.query(
        'SELECT id FROM users WHERE organization_id=$1 AND lower(email)=lower($2) LIMIT 1',
        [orgId, msg.fromAddress],
      );
      const authorId = (u[0]?.id as string | undefined) ?? null;
      await sql.query(
        `INSERT INTO ticket_comments (organization_id, ticket_id, author_id, visibility, body)
         VALUES ($1,$2,$3,'customer',$4)`,
        [orgId, ticket.id, authorId, msg.bodyPreview || '(no content)'],
      );
      await sql.query(
        `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
         VALUES ($1,$2,$3,'commented',$4)`,
        [orgId, ticket.id, authorId, { visibility: 'customer', via: 'email' }],
      );
      // A customer reply on a resolved/closed ticket reopens it.
      //
      // This used to drop the ticket straight into 'in_progress' (or 'triage'), which is not a
      // legal target from 'resolved' in any workflow map, and it left `resolved_at` stamped
      // from the earlier resolve while writing no status_changed event. The desk experience was
      // a ticket that bounced back into active work with nothing on the timeline saying why —
      // indistinguishable from "my resolve didn't save". Land on 'reopened' (what
      // DEFAULT_TRANSITIONS actually allows out of 'resolved'), clear the terminal stamps, and
      // record the change like any other status move.
      //
      // 'closed' is deliberately still reopenable here even though the map treats closed as
      // terminal: inbound mail is an out-of-band channel and a customer writing back to a closed
      // ticket must not vanish. That is an exception, so it is written down rather than implied.
      if (ticket.status === 'resolved' || ticket.status === 'closed') {
        const to = 'reopened';
        await sql.query(
          'UPDATE tickets SET status = $1, resolved_at = NULL, closed_at = NULL WHERE id = $2',
          [to, ticket.id],
        );
        await sql.query(
          `INSERT INTO ticket_events (organization_id, ticket_id, actor_id, event_type, detail)
           VALUES ($1,$2,$3,'status_changed',$4)`,
          [orgId, ticket.id, authorId, { from: ticket.status, to, via: 'email' }],
        );
        publish('ticket.reopened', orgId, { ticket_id: ticket.id, org_id: orgId, from: ticket.status, to });
      }
      // Notify the desk/assignee of the reply (NOT a customer first-response — leaves the
      // response SLA untouched; this is an inbound customer message).
      publish('ticket.commented', orgId, {
        ticket_id: ticket.id, org_id: orgId, visibility: 'customer',
        comment_excerpt: String(msg.bodyPreview ?? '').slice(0, 600),
      });
      await setState(sql, seenKey, true);
      logger.info({ ticketId: ticket.id, num: replyNum, from: msg.fromAddress }, 'inbound mail threaded onto existing ticket');
      return { created: false, reason: 'threaded', ticketId: ticket.id };
    }
  }

  // Link the sender to an existing user in the org (best-effort) so they own the
  // ticket and can see it in the portal. The acknowledgment below still reaches the
  // raw address even when the sender has no account.
  const { rows: uRows } = await sql.query(
    'SELECT id, display_name FROM users WHERE organization_id = $1 AND lower(email) = lower($2) LIMIT 1',
    [orgId, msg.fromAddress],
  );
  const requesterId = (uRows[0]?.id as string | undefined) ?? null;
  // Greeting name: linked user's name, else the sender's display name from the
  // email header, else the local-part of the address, else a neutral fallback.
  const customerName =
    (uRows[0]?.display_name as string | undefined) ||
    msg.fromName ||
    msg.fromAddress.split('@')[0] ||
    'there';

  // Email tickets default to a normal-priority assessment (impact/urgency 3) like
  // portal-created tickets, so triage + the acknowledgment show a real priority.
  const priority = derivePriority(3, 3);

  // nextTicketNumber's advisory lock is transaction-scoped (releases at COMMIT/ROLLBACK).
  // This job runs inside withSystemContext, which — unlike withOrgContext — does NOT open
  // a transaction around its callback: each `sql.query` here is otherwise its own
  // autocommitted statement. Without an explicit BEGIN, the lock would be dropped the
  // instant the lock statement itself finished, protecting nothing against a second
  // ingestMessage call (e.g. a concurrent poll tick or webhook delivery) racing the same
  // org. Wrap the allocate+insert critical section in one real transaction.
  //
  // The dedupe marker (setState(seenKey)) commits in the SAME transaction as the ticket
  // insert — not after it — so a crash between the two can never leave a committed ticket
  // with no dedupe marker (which would otherwise re-create a duplicate ticket from the
  // same email on the next poll). setState is a plain parameterized INSERT ... ON
  // CONFLICT on this same client; nothing about it depends on committing on its own.
  let ticketNumber: string;
  let ticketId: string;
  let submittedAt: string;
  try {
    await sql.query('BEGIN');
    ticketNumber = await nextTicketNumber(sql, orgId);
    const { rows: tRows } = await sql.query(
      `INSERT INTO tickets
         (organization_id, ticket_number, type, requester_id, source_channel, subject, description, status, impact, urgency, priority)
       VALUES ($1,$2,'incident',$3,'email',$4,$5,'new',3,3,$6)
       RETURNING id, created_at, priority`,
      [orgId, ticketNumber, requesterId, msg.subject, msg.bodyPreview, priority],
    );
    ticketId = tRows[0].id as string;
    submittedAt = new Date(tRows[0].created_at).toISOString();
    await setState(sql, seenKey, true);
    await sql.query('COMMIT');
  } catch (err) {
    // Don't let a failed ROLLBACK (e.g. a dropped connection) mask the real failure above.
    await sql.query('ROLLBACK').catch(() => {});
    throw err;
  }

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
      customer_name: customerName,
      submitted_at: submittedAt,
      priority,
    },
    { idempotencyKey: `ticket.acknowledged:${msg.internetMessageId}` },
  );

  return { created: true, ticketId };
}
