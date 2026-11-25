// Risk acceptance package — snapshot shape and the pure HTML renderer.
//
// A package is one organization's risks, frozen at issue time, laid out for an Authorizing Official
// to sign. Nothing here touches the database or the clock: the renderer is a function of the
// snapshot (and its hash) only, so the same inputs always produce the same page.

import { createHash } from 'node:crypto';

export interface PackageScore { l: number; i: number; score: number; rating: string }

export interface PackageRiskSnapshot {
  id: string;
  ref: string;
  title: string;
  cause: string | null;
  event: string | null;
  consequence: string | null;
  category: string;
  ownerName: string | null;
  threatSource: string | null;
  velocity: string | null;
  inherent: PackageScore;
  residual: PackageScore;
  target: PackageScore | null;
  impactDimensions: Record<string, number>;
  description: string | null;
  controls: Array<{ id: string; title: string }>;
  treatments: Array<{ title: string; status: string; dueAt: string | null }>;
  justification: string;
  expiresAt: string;
  requestedBy: string | null;
  requestedAt: string | null;
}

export interface PackageSnapshot {
  organization: { id: string; name: string };
  packageNumber: string;
  reference: string | null;
  generatedAt: string;
  generatedBy: string;
  appetite: number;
  tolerance: number;
  risks: PackageRiskSnapshot[];
}

/** sha256 of the snapshot as built (fixed key order). Taken at issue time and stored — never recomputed from jsonb, which reorders keys. */
export function snapshotSha256(s: PackageSnapshot): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex');
}

export function packageNumber(n: number): string {
  return `AP-${String(n).padStart(4, '0')}`;
}

const esc = (v: string | number | null | undefined): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Text for a CSS string literal (the @page footer): drop characters that could end the string or the style block. */
const cssText = (v: string): string => v.replace(/["'\\<>&\r\n]/g, ' ');

const label = (v: string): string => v.replace(/_/g, ' ');
const dash = (v: string | null | undefined): string => (v ? esc(v) : '&mdash;');
const dateOnly = (v: string | null): string => (v ? esc(v.slice(0, 10)) : '&mdash;');

function scoreCell(name: string, s: PackageScore | null): string {
  if (!s) return `<div class="kv"><span>${esc(name)}</span><b>&mdash;</b></div>`;
  return `<div class="kv"><span>${esc(name)}</span><b>${esc(s.score)} ${esc(label(s.rating))}</b><em>L${esc(s.l)} x I${esc(s.i)}</em></div>`;
}

function renderRisk(r: PackageRiskSnapshot, index: number): string {
  const dims = Object.entries(r.impactDimensions)
    .map(([k, v]) => `${esc(label(k))} ${esc(v)}`)
    .join(' &middot; ');
  const narrative = [['Cause', r.cause], ['Event', r.event], ['Consequence', r.consequence]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="kv wide"><span>${esc(k)}</span><p>${esc(v)}</p></div>`)
    .join('');
  const controls = r.controls.length
    ? `<ul>${r.controls.map((c) => `<li><b>${esc(c.id)}</b> ${esc(c.title)}</li>`).join('')}</ul>`
    : '<p class="muted">None linked.</p>';
  const treatments = r.treatments.length
    ? `<ul>${r.treatments
        .map((t) => `<li>${esc(t.title)} <span class="muted">(${esc(label(t.status))}${t.dueAt ? `, due ${dateOnly(t.dueAt)}` : ''})</span></li>`)
        .join('')}</ul>`
    : '<p class="muted">None recorded.</p>';
  return `<section class="risk">
  <div class="rhead"><span class="rref">${index + 1}. ${esc(r.ref)}</span><span class="cat">${esc(label(r.category))}</span></div>
  <h2>${esc(r.title)}</h2>
  ${r.description ? `<p>${esc(r.description)}</p>` : ''}
  <div class="grid">
    ${scoreCell('Inherent', r.inherent)}${scoreCell('Residual', r.residual)}${scoreCell('Target', r.target)}
    <div class="kv"><span>Owner</span><b>${dash(r.ownerName)}</b></div>
    <div class="kv"><span>Threat source</span><b>${dash(r.threatSource)}</b></div>
    <div class="kv"><span>Velocity</span><b>${dash(r.velocity)}</b></div>
  </div>
  ${narrative}
  <div class="kv wide"><span>Impact dimensions</span><p>${dims || '&mdash;'}</p></div>
  <h3>Controls</h3>${controls}
  <h3>Treatments</h3>${treatments}
  <h3>Acceptance justification</h3>
  <p class="just">${esc(r.justification)}</p>
  <div class="grid">
    <div class="kv"><span>Requested by</span><b>${dash(r.requestedBy)}</b></div>
    <div class="kv"><span>Requested on</span><b>${dateOnly(r.requestedAt)}</b></div>
    <div class="kv until"><span>Accept until</span><b>${dateOnly(r.expiresAt)}</b></div>
  </div>
</section>`;
}

export function renderPackageHtml(s: PackageSnapshot, sha256: string): string {
  const short = sha256.slice(0, 12);
  const footer = cssText(
    [s.packageNumber, s.reference, `sha256 ${short}`].filter(Boolean).join(' \u00b7 ') + ' \u00b7 Page ',
  );
  const summaryRows = s.risks
    .map(
      (r) =>
        `<tr><td>${esc(r.ref)}</td><td>${esc(r.title)}</td><td>${esc(r.residual.score)} ${esc(label(r.residual.rating))}</td><td>${dateOnly(r.expiresAt)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(s.packageNumber)} Risk Acceptance Package</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#1b2430;background:#fff;font-size:12.5px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .bar{height:6px;background:linear-gradient(90deg,#2563ef,#0e7490);margin-bottom:18px}
  h1{font-size:22px;letter-spacing:.1em;text-transform:uppercase;color:#0a1f44}
  h2{font-size:17px;color:#0a1f44;margin:4px 0 8px}
  h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:#94a3b8;margin:14px 0 4px}
  p{margin-bottom:6px}
  .muted{color:#64748b}
  .meta{margin:10px 0 18px;color:#475569;line-height:1.8}
  .meta b{color:#0a1f44}
  table{width:100%;border-collapse:collapse;margin:8px 0 18px}
  th{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;text-align:left;padding:6px 8px;border-bottom:1px solid #e6eaf0;background:#fafbfc}
  td{padding:7px 8px;border-bottom:1px solid #eef1f5;vertical-align:top}
  .risk{break-before:page}
  .rhead{display:flex;justify-content:space-between;color:#2563ef;font-weight:600;font-size:12px}
  .cat{text-transform:uppercase;letter-spacing:.1em;color:#64748b;font-size:10.5px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin:10px 0}
  .kv span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8}
  .kv b{color:#0a1f44}
  .kv em{display:block;font-style:normal;font-size:11px;color:#64748b}
  .kv.wide{margin:6px 0}
  .until b{font-size:15px}
  .just{border-left:3px solid #2563ef;background:#f0f6ff;padding:8px 12px}
  ul{margin-left:18px}
  .sign{break-before:page}
  .sign p{margin:10px 0 24px}
  .line{display:grid;grid-template-columns:90px 1fr;gap:12px;align-items:end;margin:26px 0}
  .line span{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8}
  .line i{border-bottom:1px solid #1b2430;height:22px;display:block}
  @page{size:letter;margin:0.6in;@bottom-center{content:"${footer}" counter(page);font-size:9px;color:#94a3b8}}
</style></head>
<body>
  <div class="bar"></div>
  <h1>Risk Acceptance Package</h1>
  <div class="meta">
    <b>Organization</b> ${esc(s.organization.name)}<br>
    <b>Package</b> ${esc(s.packageNumber)}<br>
    ${s.reference ? `<b>Reference</b> ${esc(s.reference)}<br>` : ''}<b>Generated</b> ${dateOnly(s.generatedAt)} by ${esc(s.generatedBy)}<br>
    <b>Risk appetite</b> ${esc(s.appetite)} &middot; <b>Tolerance</b> ${esc(s.tolerance)}
  </div>
  <h3>Risks for acceptance (${esc(s.risks.length)})</h3>
  <table><thead><tr><th>Risk</th><th>Title</th><th>Residual</th><th>Accept until</th></tr></thead><tbody>${summaryRows}</tbody></table>
${s.risks.map(renderRisk).join('\n')}
  <section class="sign">
    <h2>Authorizing Official acceptance</h2>
    <p>By signing, I accept the residual risk of each risk listed in this package until its stated expiry date.</p>
    <div class="line"><span>Name</span><i></i></div>
    <div class="line"><span>Title</span><i></i></div>
    <div class="line"><span>Signature</span><i></i></div>
    <div class="line"><span>Date</span><i></i></div>
  </section>
<script>window.onload=function(){window.print()}</script>
</body></html>`;
}
