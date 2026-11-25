import { describe, it, expect } from 'vitest';
import {
  renderPackageHtml, snapshotSha256, packageNumber,
  type PackageSnapshot, type PackageRiskSnapshot,
} from '../src/modules/acceptance-package-render.js';

const level = (l: number, i: number, score: number, rating: string) => ({ l, i, score, rating });

function risk(over: Partial<PackageRiskSnapshot> = {}): PackageRiskSnapshot {
  return {
    id: 'r1', ref: 'RISK-0001', title: 'Unpatched edge gateway', cause: 'Vendor patch lag',
    event: 'Exploit of gateway', consequence: 'Data exposure', category: 'cybersecurity',
    ownerName: 'Dana Owner', threatSource: 'External actor', velocity: 'fast',
    inherent: level(4, 4, 16, 'high'), residual: level(3, 3, 9, 'moderate'), target: level(2, 2, 4, 'low'),
    impactDimensions: { confidentiality: 4, availability: 3 }, description: 'Gateway runs an old build.',
    controls: [{ id: 'AC-2', title: 'Account Management' }],
    treatments: [{ title: 'Patch gateway', status: 'in_progress', dueAt: '2027-01-15' }],
    justification: 'Business need outweighs risk until patch window.', expiresAt: '2027-03-01',
    requestedBy: 'Sam Requester', requestedAt: '2026-11-01',
    ...over,
  };
}

function snap(over: Partial<PackageSnapshot> = {}): PackageSnapshot {
  return {
    organization: { id: 'org1', name: 'Quantifind' }, packageNumber: 'AP-0001', reference: 'RA-2026-03',
    generatedAt: '2026-11-24T12:00:00Z', generatedBy: 'Kim Admin', appetite: 8, tolerance: 15,
    risks: [risk(), risk({ id: 'r2', ref: 'RISK-0002', title: 'Legacy VPN', expiresAt: '2027-06-30' })],
    ...over,
  };
}

describe('acceptance package renderer', () => {
  it('packageNumber formats', () => {
    expect(packageNumber(1)).toBe('AP-0001');
    expect(packageNumber(123)).toBe('AP-0123');
  });

  it('renders header, summary, one section per risk and a signature block', () => {
    const s = snap();
    const html = renderPackageHtml(s, snapshotSha256(s));
    expect(html).toContain('Quantifind');
    expect(html).toContain('AP-0001');
    expect(html).toContain('RA-2026-03');
    expect(html).toContain('RISK-0001');
    expect(html).toContain('RISK-0002');
    expect(html.match(/class="risk"/g)).toHaveLength(2);
    expect(html).toContain('Accept until');
    expect(html).toContain('2027-03-01');
    expect(html).toContain('2027-06-30');
    for (const label of ['Name', 'Title', 'Signature', 'Date']) expect(html).toContain(label);
  });

  it('omits the Reference label when reference is null', () => {
    const s = snap({ reference: null });
    expect(renderPackageHtml(s, snapshotSha256(s))).not.toContain('Reference');
    const t = snap();
    expect(renderPackageHtml(t, snapshotSha256(t))).toContain('Reference');
  });

  it('deterministic', () => {
    const s = snap();
    const h = snapshotSha256(s);
    expect(renderPackageHtml(s, h)).toBe(renderPackageHtml(structuredClone(s), h));
    expect(snapshotSha256(s)).toBe(snapshotSha256(structuredClone(s)));
    const changed = snap();
    changed.risks[0]!.justification = 'Different justification.';
    expect(snapshotSha256(changed)).not.toBe(h);
  });

  it('footer carries number and short hash', () => {
    const s = snap();
    const h = snapshotSha256(s);
    const html = renderPackageHtml(s, h);
    expect(html).toContain('AP-0001');
    expect(html).toContain(h.slice(0, 12));
  });

  it('escapes every field', () => {
    const s = snap({
      risks: [risk({ title: '<script>alert(1)</script>', description: 'a & b "c"', justification: '<b>x</b>' })],
    });
    const html = renderPackageHtml(s, snapshotSha256(s));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b &quot;c&quot;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('prints on load and carries no external resources', () => {
    const s = snap();
    const html = renderPackageHtml(s, snapshotSha256(s));
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('window.print');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img src=');
  });
});
