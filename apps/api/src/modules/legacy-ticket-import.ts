// Pure mapping for the one-time import of the retired SharePoint "Tickets" list
// (strategicbusiness.sharepoint.us/sites/FederalSupport) into Nexus as closed, historical tickets.
// No I/O here: src/scripts/import-legacy-tickets.ts does the database work.

export const LEGACY_SOURCE = 'sharepoint-legacy';

/** RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Header-keyed records. Header names are trimmed ("Resolution " has a trailing space). */
export function csvRecords(text: string): Array<Record<string, string>> {
  const [header, ...body] = parseCsv(text);
  const keys = (header ?? []).map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code === 160 ? 32 : code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * Remove every tag, repeating until the text stops changing: a single pass over "<scr<b>ipt>"
 * leaves "<script>" behind. Applied both before AND after entity decoding, because "&lt;script&gt;"
 * only becomes a tag once decoded. The output is plain text; no markup survives in any form.
 */
export function stripTags(s: string): string {
  let prev: string;
  let t = s;
  do { prev = t; t = t.replace(/<\/?[a-zA-Z!?][^<>]*>/g, ''); } while (t !== prev);
  // A "<" that could still open a tag gets a space after it ("< script"), which no parser reads as
  // markup; ordinary text such as "5 < 6" is left as written.
  return t.replace(/<(?=[a-zA-Z/!?])/g, '< ');
}

/** SharePoint rich text to plain text: block tags become line breaks, list items get bullets,
 *  links keep their URL, images (dead blob: URLs) are dropped. */
export function htmlToText(html: string): string {
  if (!html) return '';
  const t = html
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = stripTags(decodeEntities(stripTags(label))).trim();
      const h = stripTags(decodeEntities(href));
      return l && l !== h ? `${l} (${h})` : h;
    })
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h\d)>/gi, '\n');
  return stripTags(decodeEntities(stripTags(t)))
    .replace(/[ \t​]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/• *\n+/g, '• ') // SharePoint wraps item text in its own line: "<li>\nText</li>"
    .replace(/\n\n+(?=• )/g, '\n') // </li><li> would otherwise double-space every item
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Credentials typed into old tickets must not be carried into the new system. */
export function redactSecrets(s: string): { text: string; redacted: boolean } {
  let redacted = false;
  const text = s.replace(/\b(login credentials|credentials|password|passcode|pwd)(\s*[:=]\s*)(\S+)/gi, (_m, label: string, sep: string) => {
    redacted = true;
    return `${label}${sep}[redacted at import]`;
  });
  return { text, redacted };
}

/** "Wise, Taylor" -> "Taylor Wise"; "<Inactive> Shepherd, Ethan" -> "Ethan Shepherd". */
export function normalizePerson(raw: string): { name: string; inactive: boolean } | null {
  const inactive = /<inactive>/i.test(raw);
  const s = raw.replace(/<inactive>/gi, '').trim();
  if (!s) return null;
  const m = s.match(/^([^,]+),\s*(.+)$/);
  return { name: m ? `${m[2].trim()} ${m[1].trim()}` : s, inactive };
}

/** Comparable key: lowercase letters only, so "De Camp, Barry" matches "Barry DeCamp". */
export const personKey = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '');

const TYPE_MAP: Record<string, string> = {
  'incident management': 'incident',
  'problem management': 'incident',
  'access management (or identity and access issues)': 'incident',
  'service request management': 'service_request',
  'request fulfillment': 'service_request',
};

/** Legacy priority -> impact/urgency, chosen so derivePriority reproduces P1..P4. */
const PRIORITY_MAP: Record<string, { impact: number; urgency: number }> = {
  critical: { impact: 1, urgency: 1 }, // P1
  high: { impact: 2, urgency: 2 }, // P2
  normal: { impact: 3, urgency: 3 }, // P3
  low: { impact: 4, urgency: 4 }, // P4
};

/**
 * "8/26/2026 4:29 AM" in the list's regional time zone -> ISO instant. SharePoint exports
 * local wall-clock time with no offset; the site is in Chantilly, VA.
 */
export function parseLegacyDate(s: string, timeZone = 'America/New_York'): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (m[6].toUpperCase() === 'PM') h += 12;
  const wall = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]));
  // Offset of the zone at that instant (two passes settle DST edges).
  let utc = wall;
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
    const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    utc = wall - (asLocal - utc);
  }
  return new Date(utc).toISOString();
}

export const legacyNumber = (id: string) => `SPL-${id.padStart(6, '0')}`;

export interface LegacyTicket {
  legacyId: string;
  ticketNumber: string;
  externalRef: string;
  type: string;
  category: string;
  subject: string;
  description: string | null;
  impact: number;
  urgency: number;
  createdAt: string;
  requesterName: string | null;
  assignedTo: string[];
  notes: string | null;
  resolution: string;
  legacyStatus: string;
  hadAttachments: boolean;
  relatedIssue: string | null;
  redacted: boolean;
}

export function mapLegacyRow(r: Record<string, string>): LegacyTicket {
  const id = r['ID'].trim();
  if (!/^\d+$/.test(id)) throw new Error(`row has no numeric ID: ${JSON.stringify(r['ID'])}`);
  const createdAt = parseLegacyDate(r['Created']);
  if (!createdAt) throw new Error(`ticket ${id}: unparseable Created ${JSON.stringify(r['Created'])}`);
  const legacyType = r['Issue Type'].trim();
  const pr = PRIORITY_MAP[r['Priority'].trim().toLowerCase()] ?? PRIORITY_MAP.normal;
  let redacted = false;
  const clean = (s: string) => { const out = redactSecrets(s); redacted ||= out.redacted; return out.text; };

  const description = clean(htmlToText(r['Issue description'] ?? ''));
  const notes = clean((r['Notes'] ?? '').replace(/\r\n/g, '\n').trim());
  const legacyStatus = r['Status'].trim();
  let resolution = clean((r['Resolution'] ?? '').replace(/\r\n/g, '\n').trim());
  if (legacyStatus.toLowerCase() !== 'completed') {
    resolution = `Closed at migration: this ticket was "${legacyStatus}" in the retired SharePoint system when it was decommissioned. Reopen it if the work is still active.${resolution ? `\n\n${resolution}` : ''}`;
  }
  return {
    legacyId: id,
    ticketNumber: legacyNumber(id),
    externalRef: `${LEGACY_SOURCE}:FederalSupport/Tickets:${id}`,
    type: TYPE_MAP[legacyType.toLowerCase()] ?? 'incident',
    category: legacyType || 'Uncategorized',
    subject: (decodeEntities(r['Issue Title']).trim() || `Legacy ticket ${id}`).slice(0, 500),
    description: description || null,
    impact: pr.impact,
    urgency: pr.urgency,
    createdAt,
    requesterName: normalizePerson(r['Created By'] ?? '')?.name ?? null,
    assignedTo: (r['Assigned To'] ?? '').split(';').map(normalizePerson).filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.name),
    notes: notes || null,
    resolution: resolution || 'Closed in the legacy SharePoint ticket system (no resolution recorded).',
    legacyStatus,
    hadAttachments: (r['Associated files'] ?? '').trim() !== '' && r['Associated files'].trim() !== '0',
    relatedIssue: (r['Related issue'] ?? '').trim() || null,
    redacted,
  };
}

// ---------------------------------------------------------------- change requests

export interface LegacyChange {
  externalRef: string;
  title: string;
  description: string;
  changeType: 'normal' | 'emergency';
  risk: 'low' | 'medium' | 'high';
  implementationPlan: string | null;
  backoutPlan: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  implementerName: string | null;
  notes: string | null;
  redacted: boolean;
}

const RISK_MAP: Array<[RegExp, LegacyChange['risk']]> = [[/high/i, 'high'], [/low/i, 'low'], [/medium|normal/i, 'medium']];

/** Plain text from a SharePoint multi-line field: entities decoded, CRLF normalized. */
const plain = (s: string | undefined) => htmlToText((s ?? '').replace(/\r\n/g, '\n').replace(/\n/g, '<br>'));

/** The "Backout Plan:" / "Rollback Plan" section of a free-text change description, if any. */
export function extractBackout(text: string): string | null {
  const m = text.match(/(?:^|\n)\s*(?:Rollback\s*\/\s*)?(?:Backout|Rollback)(?: \/ Backout)? Plan\s*:?\s*\n?([\s\S]*?)(?=\n\s*\n(?:Planned Implementation|Approver|Summary Table|Optional|Phase|$)|\nPlanned Implementation|$)/i);
  const body = m?.[1]?.trim();
  return body ? body : null;
}

export function mapLegacyChange(r: Record<string, string>): LegacyChange {
  const title = decodeEntities(r['ChangeTitle'] ?? '').trim();
  if (!title) throw new Error('change row has no ChangeTitle');
  const createdAt = parseLegacyDate(r['Created'] ?? '');
  if (!createdAt) throw new Error(`change "${title}": unparseable Created ${JSON.stringify(r['Created'])}`);
  let redacted = false;
  const clean = (s: string) => { const out = redactSecrets(s); redacted ||= out.redacted; return out.text; };

  const body = clean(plain(r['Description']));
  const person = (s: string | undefined) => (s ?? '').split(';').map(normalizePerson).filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.name);
  const date = (s: string | undefined) => { const iso = parseLegacyDate(s ?? ''); return iso ? iso.slice(0, 10) : ((s ?? '').trim() || null); };

  const meta: Array<[string, string | null]> = [
    ['Legacy change type', (r['Change Type'] ?? '').trim() || null],
    ['Legacy status', [r['Issue Status'], r['Change Status']].map((s) => (s ?? '').trim()).filter(Boolean).join(' / ') || null],
    ['Implementation status', clean(plain(r['Change Implementation Status'])) || null],
    ['Requested by', person(r['Requested by']).join(', ') || null],
    ['Responsible party', person(r['Responsible Party']).join(', ') || null],
    ['Assigned to', person(r['Assigned To']).join(', ') || null],
    ['Date requested', date(r['Date Requested'])],
    ['Due date', date(r['Due Date'])],
    ['Last update', date(r['Last Update'])],
    ['Legacy impact', (r['Impact'] ?? '').trim() || null],
    ['Risk level', (r['Risk Level'] ?? '').trim() || null],
    ['Risk acceptance', (r['Risk Acceptance'] ?? '').trim() || null],
    ['Approval authority', (r['Approval Authority'] ?? '').trim() || null],
    ['Vote tracking', (r['Vote Tracking'] ?? '').trim() || null],
    ['Escalation required', /^true$/i.test((r['Escalation Required'] ?? '').trim()) ? 'Yes' : null],
  ];
  const sections: string[] = [
    'Imported from the retired SharePoint Change Request list (FederalSupport). Closed at migration.',
    meta.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n'),
  ];
  if (body) sections.push(body);
  const impactDesc = clean(plain(r['Impact Description']));
  if (impactDesc) sections.push(`Impact description:\n${impactDesc}`);
  const controls = clean(plain(r['Impacted Controls']));
  if (controls && !/^none$/i.test(controls)) sections.push(`Impacted controls:\n${controls}`);

  const actions = clean(plain(r['Actions Required']));
  const notes = clean(plain(r['Notes']));
  const all = [body, actions, notes].join('\n');

  const updated = parseLegacyDate(r['Last Update'] ?? '');
  return {
    // The list export carries no ID column, so the key is the creation instant plus the title:
    // stable across re-exports of the same list, distinct for every row in it.
    externalRef: `${LEGACY_SOURCE}:FederalSupport/ChangeRequests:${createdAt}:${title.toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`,
    title: title.slice(0, 500),
    description: sections.join('\n\n'),
    changeType: /\bemergency change\b/i.test(all) ? 'emergency' : 'normal',
    risk: RISK_MAP.find(([re]) => re.test(r['Risk Level'] || r['Impact'] || ''))?.[1] ?? 'medium',
    implementationPlan: actions && !/^none$/i.test(actions) ? actions : null,
    backoutPlan: extractBackout(body) ?? extractBackout(notes) ?? extractBackout(actions),
    createdAt,
    updatedAt: updated && updated > createdAt ? updated : createdAt,
    createdByName: normalizePerson(r['Created By'] ?? '')?.name ?? null,
    implementerName: person(r['Responsible Party'])[0] ?? null,
    notes: notes || null,
    redacted,
  };
}

// ---------------------------------------------------------------- risk register (spreadsheet)

export interface LegacyRiskTreatment { title: string; status: 'planned' | 'in_progress' | 'done' }

export interface LegacyRisk {
  legacyId: string; // R001
  riskNumber: number; // 1 -> R-0001, so the old ids still line up
  title: string;
  description: string;
  consequence: string | null;
  category: string;
  status: 'identified' | 'assessed' | 'treating' | 'monitoring' | 'closed';
  strategy: 'mitigate' | null;
  ownerName: string | null;
  inherent: { likelihood: number; impact: number };
  residual: { likelihood: number; impact: number };
  unscored: boolean;
  controls: string[]; // NIST SP 800-53 ids, normalized: "CM-06" -> "CM-6", "CM-03(08)" -> "CM-3(8)"
  treatments: LegacyRiskTreatment[];
  tags: string[];
  note: string | null;
}

const rate = (s: string | undefined) => { const n = Number((s ?? '').trim()); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };
const unquote = (s: string | undefined) => (s ?? '').trim().replace(/^"+|"+$/g, '').trim();

/** "CM-06 AC-02", "SC-07(10)", "SI-2, SR-3" -> ["CM-6","AC-2","SC-7(10)","SI-2","SR-3"]. */
export function parseControls(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.toUpperCase().matchAll(/\b([A-Z]{2})-0*(\d{1,2})(?:\s*\(0*(\d{1,2})\))?/g)) {
    out.add(`${m[1]}-${m[2]}${m[3] ? `(${m[3]})` : ''}`);
  }
  return [...out];
}

/** "1. Do A 2. Do B" -> ["Do A","Do B"]; anything else is a single treatment. */
export function splitMitigation(s: string): string[] {
  const parts = s.split(/\s*(?:^|\s)\d+\.\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : (s.trim() ? [s.trim()] : []);
}

function riskCategory(text: string): string {
  if (/poam|cmmc|compliance initiative|retention/i.test(text)) return 'compliance';
  if (/peraton|vendor|third[- ]party|prime contractor/i.test(text)) return 'third_party';
  if (/runtime|build|ci\/cd|python|node\.js/i.test(text)) return 'technology';
  if (/\bpii\b|privacy/i.test(text)) return 'privacy';
  return 'cybersecurity';
}

/**
 * Rows of the SBSFederal risk-register workbook. The sheet has a title block, a column-header
 * row starting "Risk ID", and a guidance row ("Unique Identifier") under it; columns are read by
 * position because two of them share the header "Priority Level".
 */
export function legacyRiskRows(text: string): string[][] {
  const rows = parseCsv(text);
  const h = rows.findIndex((r) => r[0]?.trim() === 'Risk ID');
  if (h < 0) throw new Error('no "Risk ID" header row found');
  return rows.slice(h + 1).filter((r) => /^R\d+$/i.test(r[0]?.trim() ?? ''));
}

export function mapLegacyRisk(r: string[]): LegacyRisk {
  const [id, desc, source, impactDesc, controlsRaw, owner, imp, prob, , mitigation, upImp, upProb, , changeId, decisionIds, comments] =
    r.map((c) => decodeEntities(c ?? ''));
  const legacyId = id.trim().toUpperCase();
  const description = unquote(desc).replace(/\s+/g, ' ');
  const consequence = unquote(impactDesc) || null;
  const mitigationText = unquote(mitigation);
  const comment = unquote(comments);
  const ii = rate(imp); const ip = rate(prob);
  const ri = rate(upImp); const rp = rate(upProb);
  const unscored = ii === null || ip === null;
  const inherent = unscored ? { likelihood: 3, impact: 3 } : { likelihood: ip!, impact: ii! };
  const residual = ri !== null && rp !== null ? { likelihood: rp, impact: ri } : inherent;

  const resolved = /\bresolved\b/i.test(comment);
  const steps = /^reference /i.test(mitigationText) || /^tbd\b/i.test(mitigationText) ? [] : splitMitigation(mitigationText);
  const done = new Set([...comment.matchAll(/mitigation item (\d+) completed/gi)].map((m) => Number(m[1])));
  const outstanding = new Set([...comment.matchAll(/mitigation item (\d+) outstanding/gi)].map((m) => Number(m[1])));
  const treatments: LegacyRiskTreatment[] = steps.map((t, i) => ({
    title: t.length > 200 ? `${t.slice(0, 197)}…` : t,
    status: resolved || done.has(i + 1) ? 'done' : outstanding.has(i + 1) ? 'in_progress' : 'planned',
  }));
  const residualMoved = residual !== inherent && residual.likelihood * residual.impact < inherent.likelihood * inherent.impact;
  const status: LegacyRisk['status'] = resolved ? 'closed'
    : unscored ? 'identified'
      : residualMoved ? 'monitoring'
        : treatments.length ? 'treating' : 'assessed';

  const meta = [
    'Imported from the SBSFederal Security & Compliance Initiative risk register (spreadsheet).',
    `Legacy id: ${legacyId}`,
    unquote(source) && `Identified by: ${unquote(source)}`,
    owner.trim() && `Owner (legacy): ${unquote(owner).replace(/\s+/g, ' ')}`,
    unquote(controlsRaw) && `Impacted controls: ${unquote(controlsRaw).replace(/\s+/g, ' ')}`,
    changeId.trim() && `Associated change log #: ${changeId.trim()}`,
    decisionIds.trim() && `Associated decision log #: ${decisionIds.trim()}`,
    mitigationText && `Mitigation plan: ${mitigationText}`,
    comment && `Comments: ${comment}`,
    unscored && 'Not scored in the legacy register: likelihood/impact are a 3×3 placeholder until assessed.',
  ].filter(Boolean).join('\n');

  const title = description.length > 160 ? `${description.slice(0, 157).replace(/\s+\S*$/, '')}…` : description;
  return {
    legacyId,
    riskNumber: Number(legacyId.slice(1)),
    title,
    description: `${description}\n\n${meta}`,
    consequence,
    category: riskCategory(`${description} ${consequence ?? ''} ${unquote(source)}`),
    status,
    strategy: treatments.length || residualMoved ? 'mitigate' : null,
    ownerName: unquote(owner).replace(/\s+/g, ' ') || null,
    inherent,
    residual,
    unscored,
    controls: parseControls(controlsRaw),
    treatments,
    tags: ['legacy-import', ...(unscored ? ['needs-assessment'] : []), ...decisionIds.split(/[,\s]+/).filter((d) => /^D\d+$/i.test(d)).map((d) => d.toUpperCase())],
    note: comment || null,
  };
}
