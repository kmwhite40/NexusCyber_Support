// Pure mapping for the GDAP configuration risk register (SBS-GRC-RR-GDAP) into the live risk
// register. The export carries the form's own column names ("Because of (cause)", ...), one row
// per risk, and names the customer tenant inside the description:
//   "[GDAP-SBS-01] Tenant: SBS Federal (sbsfederal.com, d0529da6-...)."
// Each row is filed in the organization whose entra_tenant_id is that tenant id. No I/O here:
// src/scripts/import-gdap-risks.ts does the database work.
import { csvRecords } from './legacy-ticket-import.js';
import {
  LIKELIHOOD_LABELS, IMPACT_LABELS, CATEGORIES, IMPACT_DIMENSIONS,
  type RiskCategory, type ImpactDimension,
} from './risk-scoring.js';

export const GDAP_SOURCE = 'sbs-grc-rr-gdap';

export interface GdapTreatment { title: string; description: string; ownerName: string | null; dueAt: string | null }

export interface GdapRisk {
  registerId: string;                // GDAP-SBS-01 -> external_ref
  tenantId: string;                  // Entra tenant id -> organizations.entra_tenant_id
  tenantName: string;
  title: string;
  description: string;
  cause: string;
  event: string;
  consequence: string;
  category: RiskCategory;
  threatSource: 'adversarial' | 'accidental' | 'structural' | 'environmental';
  strategy: 'mitigate' | 'transfer' | 'avoid' | 'accept';
  velocity: 'slow' | 'moderate' | 'rapid' | 'immediate';
  inherent: { likelihood: number; impact: number };
  residual: { likelihood: number; impact: number };
  target: { likelihood: number; impact: number };
  impactDimensions: Partial<Record<ImpactDimension, number>>;
  ownerName: string;
  reviewFrequencyDays: number;
  tags: string[];
  treatments: GdapTreatment[];
  controls: string[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function level(labels: readonly string[], raw: string, field: string): number {
  const i = labels.findIndex((l) => l.toLowerCase() === raw.trim().toLowerCase());
  if (i < 0) throw new Error(`${field}: "${raw}" is not one of ${labels.join(', ')}`);
  return i + 1;
}

function oneOf<T extends string>(allowed: readonly T[], raw: string, field: string): T {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '_') as T;
  if (!allowed.includes(v)) throw new Error(`${field}: "${raw}" is not one of ${allowed.join(', ')}`);
  return v;
}

// The register states velocity as time-to-impact; the form's COSO scale is slow..immediate.
const VELOCITY: Record<string, GdapRisk['velocity']> = {
  immediate: 'immediate', days: 'rapid', weeks: 'moderate', months: 'slow',
  rapid: 'rapid', moderate: 'moderate', slow: 'slow',
};

/** "Treatment plan: (1) Do A. Owner: X; target 2026-12-15. (2) ..." -> one treatment per item. */
export function parseTreatments(description: string): GdapTreatment[] {
  const m = description.match(/Treatment plan:\s*([\s\S]*?)(?:\n\s*\n|Control mapping:|$)/);
  if (!m) return [];
  return m[1].split(/\(\d+\)\s+/).map((s) => s.trim()).filter(Boolean).map((item) => {
    const owner = item.match(/Owner:\s*([^;]+);/);
    const date = item.match(/target[^;]*?(\d{4}-\d{2}-\d{2})/i);
    const body = item.replace(/\s*Owner:[\s\S]*$/, '').trim();
    // The first sentence (to the first colon or period) is the title; the full text is kept.
    const title = body.split(/:\s|\.\s/)[0].replace(/\.$/, '').slice(0, 200);
    return { title, description: item, ownerName: owner ? owner[1].trim() : null, dueAt: date ? date[1] : null };
  });
}

/** "Control mapping: AC.L2-3.1.5; AC-2(4); AC-6(7)." -> ["AC.L2-3.1.5","AC-2(4)","AC-6(7)"]. */
export function parseControlMapping(description: string): string[] {
  const m = description.match(/Control mapping:\s*([^\n]*?)\.\s*(?:Identified|$)/);
  return m ? m[1].split(';').map((s) => s.trim()).filter(Boolean) : [];
}

export function mapGdapRow(r: Record<string, string>): GdapRisk {
  const description = r['Description'] ?? '';
  const id = description.match(/^\[([A-Z0-9-]+)\]/)?.[1] ?? r['Title'].match(/^([A-Z0-9-]+):/)?.[1];
  if (!id) throw new Error(`no register id in "${r['Title']}"`);
  const tenant = description.match(new RegExp(`Tenant:\\s*([^(]+?)\\s*\\([^,]*,\\s*(${UUID})\\)`, 'i'));
  if (!tenant) throw new Error(`${id}: no "Tenant: name (domain, tenant-id)" in description`);

  const dims: Partial<Record<ImpactDimension, number>> = {};
  for (const d of IMPACT_DIMENSIONS) {
    const raw = (r[d[0].toUpperCase() + d.slice(1)] ?? '').trim();
    if (raw && raw.toUpperCase() !== 'N/A') dims[d] = level(IMPACT_LABELS, raw, `${id} ${d}`);
  }
  const velocity = VELOCITY[(r['Velocity'] ?? '').trim().toLowerCase()];
  if (!velocity) throw new Error(`${id}: unknown velocity "${r['Velocity']}"`);
  const review = Number(r['Review every (days)']);

  return {
    registerId: id,
    tenantId: tenant[2].toLowerCase(),
    tenantName: tenant[1].trim(),
    title: r['Title'].trim(),
    description,
    cause: r['Because of (cause)'].trim(),
    event: r['This may happen (event)'].trim(),
    consequence: r['Leading to (consequence)'].trim(),
    category: oneOf(CATEGORIES, r['Category'], `${id} category`),
    threatSource: oneOf(['adversarial', 'accidental', 'structural', 'environmental'] as const, r['Threat source'], `${id} threat source`),
    strategy: oneOf(['mitigate', 'transfer', 'avoid', 'accept'] as const, r['Response strategy'], `${id} strategy`),
    velocity,
    inherent: { likelihood: level(LIKELIHOOD_LABELS, r['Inherent likelihood'], `${id} inherent likelihood`), impact: level(IMPACT_LABELS, r['Inherent impact'], `${id} inherent impact`) },
    residual: { likelihood: level(LIKELIHOOD_LABELS, r['Residual likelihood'], `${id} residual likelihood`), impact: level(IMPACT_LABELS, r['Residual impact'], `${id} residual impact`) },
    target: { likelihood: level(LIKELIHOOD_LABELS, r['Target likelihood'], `${id} target likelihood`), impact: level(IMPACT_LABELS, r['Target impact'], `${id} target impact`) },
    impactDimensions: dims,
    ownerName: r['Owner (name)'].trim(),
    reviewFrequencyDays: Number.isInteger(review) && review > 0 ? review : 90,
    tags: (r['Tags'] ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    treatments: parseTreatments(description),
    controls: parseControlMapping(description),
  };
}

export const gdapRisks = (csv: string): GdapRisk[] => csvRecords(csv).map(mapGdapRow);
