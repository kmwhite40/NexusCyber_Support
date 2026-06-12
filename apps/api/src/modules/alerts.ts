// Operations alerts (Opsgenie-style). triggered -> acknowledged -> resolved, with dedup on
// (org, dedup_key) for open alerts, and escalation into an on-call page and/or ticket.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { authorize } from '../authz/pdp.js';
import { audit } from './audit.js';
import { publish } from '../events/bus.js';
import { Errors } from '../errors.js';
import * as oncall from './oncall.js';
import * as tickets from './tickets.js';
import type { Principal } from '../types.js';

export type AlertState = 'triggered' | 'acknowledged' | 'resolved';

const TRANSITIONS: Record<AlertState, AlertState[]> = {
  triggered: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

/** Is an alert state transition allowed? Pure. */
export function canAlertTransition(from: AlertState, to: AlertState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
