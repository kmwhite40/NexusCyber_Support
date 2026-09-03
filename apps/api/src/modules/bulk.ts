// Bulk ticket actions (JSM parity). Applies one action across many tickets, reusing the
// single-ticket module functions so each operation keeps its own authorization, audit, and
// events. Each ticket is processed independently; one failure does not abort the batch.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { Errors } from '../errors.js';
import * as tickets from './tickets.js';
import type { Principal } from '../types.js';

export type BulkAction = 'assign' | 'transition' | 'comment' | 'escalate' | 'tag';
export const BULK_ACTIONS: BulkAction[] = ['assign', 'transition', 'comment', 'escalate', 'tag'];
export const MAX_BULK = 200;

/** Is this a known bulk action? Pure. */
export function isValidBulkAction(a: string): a is BulkAction {
  return (BULK_ACTIONS as string[]).includes(a);
}

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Tally a set of per-ticket results. Pure. */
export function summarize(results: BulkResult[]): { total: number; succeeded: number; failed: number } {
  const succeeded = results.filter((r) => r.ok).length;
  return { total: results.length, succeeded, failed: results.length - succeeded };
}

export interface BulkParams {
  // assign
  assignedAgentId?: string | null;
  assignmentGroupId?: string | null;
  // transition
  to?: string;
  resolutionCode?: string;
  // comment
  body?: string;
  visibility?: 'customer' | 'internal';
  // escalate
  targetGroup?: string;
  reason?: string;
  // tag
  tag?: string;
}

async function applyOne(actor: Principal, id: string, action: BulkAction, params: BulkParams): Promise<void> {
  switch (action) {
    case 'assign':
      await tickets.assignTicket(actor, id, params.assignedAgentId ?? null, params.assignmentGroupId ?? null);
      return;
    case 'transition':
      if (!params.to) throw Errors.badRequest('to is required for transition');
      await tickets.transition(actor, id, params.to, { resolutionCode: params.resolutionCode });
      return;
    case 'comment':
      if (!params.body) throw Errors.badRequest('body is required for comment');
      await tickets.addComment(actor, id, params.body, params.visibility ?? 'customer');
      return;
    case 'escalate':
      if (!params.targetGroup) throw Errors.badRequest('targetGroup is required for escalate');
      await tickets.escalate(actor, id, params.targetGroup, params.reason);
      return;
    case 'tag':
      if (!params.tag) throw Errors.badRequest('tag is required for tag');
      await withOrgContext(orgContextFor(actor), async (sql) => {
        const t = (await sql.query('SELECT organization_id FROM tickets WHERE id=$1', [id])).rows[0];
        if (!t) throw Errors.notFound('ticket not found');
        authorize(actor, 'ticket.update', { organizationId: t.organization_id });
        await sql.query('UPDATE tickets SET tags = array_append(tags, $1) WHERE id=$2 AND NOT ($1 = ANY(tags))', [params.tag, id]);
      });
      return;
  }
}

export async function bulkAction(actor: Principal, ticketIds: string[], action: string, params: BulkParams = {}) {
  if (!isValidBulkAction(action)) throw Errors.badRequest(`unknown bulk action: ${action}`);
  if (ticketIds.length === 0) throw Errors.badRequest('no ticket ids provided');
  if (ticketIds.length > MAX_BULK) throw Errors.badRequest(`too many tickets (max ${MAX_BULK})`);

  const results: BulkResult[] = [];
  for (const id of ticketIds) {
    try {
      await applyOne(actor, id, action, params);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : 'failed' });
    }
  }
  const summary = summarize(results);
  await audit(actor, { action: 'ticket.bulk', resourceType: 'ticket', detail: { bulk_action: action, ...summary } });
  return { ...summary, results };
}
