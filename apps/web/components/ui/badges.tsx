'use client';
import { Badge } from './primitives';

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'brand' | 'neutral'> = {
  P1: 'danger', P2: 'warning', P3: 'brand', P4: 'neutral',
};
export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{priority}</Badge>;
}

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'warning' | 'success' | 'accent'> = {
  new: 'neutral', triage: 'accent', assigned: 'brand', in_progress: 'brand',
  waiting_customer: 'warning', waiting_vendor: 'warning', on_hold: 'warning',
  resolved: 'success', closed: 'neutral', reopened: 'warning',
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'brand' | 'neutral'> = {
  critical: 'danger', high: 'danger', moderate: 'warning', low: 'brand', info: 'neutral',
};
export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={SEVERITY_TONE[severity] ?? 'neutral'}>{severity}</Badge>;
}

export function SlaBadge({ state }: { state: string }) {
  const tone = state === 'breached' ? 'danger' : state === 'warning' ? 'warning' : state === 'met' ? 'success' : 'brand';
  return <Badge tone={tone}>SLA {state}</Badge>;
}

export function CloudBadge({ cloud }: { cloud: string }) {
  const isGov = cloud === 'gcchigh' || cloud === 'azgov' || cloud === 'gcc';
  return <Badge tone={isGov ? 'accent' : 'neutral'}>{cloud}{isGov ? ' • gov' : ''}</Badge>;
}
