'use client';
import * as React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Button, Field, Input } from '@/components/ui/primitives';
import { EmptyState, Skeleton } from '@/components/ui/data';
import { ApiError, attachmentsApi } from '@/lib/api';
import { risksApi, type AcceptancePackage, type PackageDecision, type Risk } from '@/lib/risks';

const STATUS_TONE: Record<string, 'brand' | 'success' | 'neutral'> = { issued: 'brand', signed: 'success', void: 'neutral' };
const day = (iso: string) => iso.slice(0, 10);

/**
 * Risk acceptance packages: print-ready documents of requested acceptances for an Authorizing
 * Official to sign on paper. Generate, reprint, void, record the signed copy, download it.
 */
export function AcceptancePackagesPanel({
  organizationId, canManage, canAccept, risks, onChanged,
}: {
  organizationId: string | undefined;
  canManage: boolean;
  canAccept: boolean;
  risks: Risk[];
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Acceptance packages</Button>
      {open && (
        <PackagesDialog
          organizationId={organizationId} canManage={canManage} canAccept={canAccept}
          risks={risks} onChanged={onChanged} onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PackagesDialog({
  organizationId, canManage, canAccept, risks, onChanged, onClose,
}: {
  organizationId: string | undefined;
  canManage: boolean;
  canAccept: boolean;
  risks: Risk[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [rows, setRows] = React.useState<AcceptancePackage[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reference, setReference] = React.useState('');
  const [unticked, setUnticked] = React.useState<Set<string>>(new Set());
  const [recording, setRecording] = React.useState<AcceptancePackage | null>(null);
  const [voiding, setVoiding] = React.useState<{ pkg: AcceptancePackage; reason: string } | null>(null);

  const load = React.useCallback(() => {
    risksApi.packages(organizationId).then(setRows).catch((e) => { setRows([]); setError(e instanceof ApiError ? e.detail : 'Could not load packages'); });
  }, [organizationId]);
  React.useEffect(load, [load]);

  const eligible = React.useMemo(() => {
    const held = new Set((rows ?? []).filter((p) => p.status === 'issued').flatMap((p) => p.risk_ids));
    return risks.filter((r) => r.acceptance_status === 'requested' && !held.has(r.id));
  }, [risks, rows]);
  const chosen = eligible.filter((r) => !unticked.has(r.id));
  const refByRisk = React.useMemo(() => new Map(risks.map((r) => [r.id, r.ref])), [risks]);

  async function run(fn: () => Promise<unknown>, fail: string, refresh = true): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (refresh) { load(); onChanged(); }
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : fail);
      load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  // window.open must run synchronously inside the click, so reprint calls openPackage straight away.
  const reprint = (p: AcceptancePackage) => run(() => risksApi.openPackage(p.id), 'Could not open the package', false);

  function generate() {
    // Open the print tab NOW, inside the click: after the POST it would count as a pop-up and be blocked.
    // If it is blocked, say so without issuing (an issued package the person cannot print is a trap).
    const win = window.open('', '_blank');
    if (!win) { setError('Allow pop-ups for Anchor to print the package'); return; }
    setBusy(true);
    setError(null);
    risksApi.issuePackage(organizationId, chosen.map((r) => r.id), reference)
      .then(async (pkg) => {
        setReference('');
        setUnticked(new Set());
        load();
        onChanged();
        try { await risksApi.openPackage(pkg.id, win); } catch (e) { setError(e instanceof ApiError ? e.detail : 'Could not open the package; use Reprint'); }
      })
      .catch((e) => { win.close(); setError(e instanceof ApiError ? e.detail : 'Could not generate the package'); load(); })
      .finally(() => setBusy(false));
  }

  return (
    <Dialog title="Risk acceptance packages" onClose={onClose} size="xl"
      footer={<div className="flex items-center justify-between gap-2"><p className="text-xs text-danger" role="alert">{error}</p><Button variant="ghost" onClick={onClose}>Close</Button></div>}>
      <p className="mb-4 text-sm text-muted">
        A package freezes the requested risk acceptances into one document to print and sign by the Authorizing Official. Record the signed copy afterwards.
      </p>

      {canManage && rows && (
        <section aria-label="Generate package" className="mb-5 rounded-md border border-border p-3">
          <h3 className="mb-2 text-sm font-semibold">Generate package</h3>
          {eligible.length === 0 ? (
            <p className="text-sm text-muted">No risks are awaiting acceptance. Request acceptance on a risk first.</p>
          ) : (
            <>
              <ul className="mb-3 space-y-1">
                {eligible.map((r) => (
                  <li key={r.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!unticked.has(r.id)}
                        onChange={() => setUnticked((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                      <span className="font-mono text-xs text-muted">{r.ref}</span> {r.title}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-64">
                  <Field label="Reference (optional)">
                    <Input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
                  </Field>
                </div>
                <Button className="mb-4" onClick={generate} disabled={busy || chosen.length === 0 || chosen.length > 50}>
                  {busy ? 'Working…' : `Generate package (${chosen.length})`}
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {rows === null ? <Skeleton className="h-24 w-full" /> : rows.length === 0 ? (
        <EmptyState title="No packages yet" description="Generated packages appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Package</th><th className="pr-3 font-medium">Reference</th>
                <th className="pr-3 font-medium">Status</th><th className="pr-3 font-medium">Risks</th>
                <th className="pr-3 font-medium">Generated</th><th className="pr-3 font-medium">Signed</th>
                <th className="font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-border align-top">
                  <td className="py-2 pr-3 font-mono text-xs">{p.number}</td>
                  <td className="pr-3">{p.reference ?? '—'}</td>
                  <td className="pr-3"><Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge></td>
                  <td className="pr-3" title={p.risk_ids.map((id) => refByRisk.get(id) ?? '').filter(Boolean).join(', ') || undefined}>{p.risk_ids.length}</td>
                  <td className="pr-3">{day(p.generated_at)}</td>
                  <td className="pr-3">{p.signed_by_name ? `${p.signed_by_name}${p.signed_on ? `, ${p.signed_on}` : ''}` : '—'}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => reprint(p)} aria-label={`Reprint ${p.number}`}>Reprint</Button>
                      {canAccept && p.status === 'issued' && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRecording(p)} aria-label={`Record signature for ${p.number}`}>Record signature</Button>
                      )}
                      {p.signed_attachment_id && (
                        <Button size="sm" variant="ghost" disabled={busy} aria-label={`Download signed copy of ${p.number}`}
                          onClick={() => run(() => attachmentsApi.download(p.signed_attachment_id!, `${p.number}-signed`), 'Could not download the signed copy', false)}>
                          Download signed copy
                        </Button>
                      )}
                      {canManage && p.status === 'issued' && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setVoiding({ pkg: p, reason: '' })} aria-label={`Void ${p.number}`}>Void</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recording && (
        <RecordDialog pkg={recording} risks={risks} onClose={() => setRecording(null)}
          onRecorded={() => { setRecording(null); load(); onChanged(); }} />
      )}

      {voiding && (
        <Dialog title={`Void ${voiding.pkg.number}`} size="sm" onClose={() => setVoiding(null)}
          footer={<div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button>
            <Button disabled={busy || voiding.reason.trim().length < 3}
              onClick={async () => { const v = voiding; if (await run(() => risksApi.voidPackage(v.pkg.id, v.reason.trim()), 'Could not void the package')) setVoiding(null); }}>
              Void package
            </Button>
          </div>}>
          <p className="mb-3 text-sm text-muted">Its risks return to awaiting acceptance and can go into a new package.</p>
          <Field label="Reason">
            <Input value={voiding.reason} maxLength={500} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
          </Field>
        </Dialog>
      )}
    </Dialog>
  );
}

const DECISIONS: Array<{ value: PackageDecision; label: string }> = [
  { value: 'accepted', label: 'Accepted' },
  { value: 'not_accepted', label: 'Not accepted' },
  { value: 'not_marked', label: 'Not marked' },
];

/** Record the Authorizing Official's signature: the signed copy plus the mark made against each risk. */
function RecordDialog({ pkg, risks, onClose, onRecorded }: {
  pkg: AcceptancePackage; risks: Risk[]; onClose: () => void; onRecorded: () => void;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [signedOn, setSignedOn] = React.useState('');
  const [decisions, setDecisions] = React.useState<Record<string, PackageDecision>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const byId = React.useMemo(() => new Map(risks.map((r) => [r.id, r])), [risks]);

  const ready = !!file && name.trim().length >= 2 && title.trim().length >= 2 && !!signedOn
    && pkg.risk_ids.every((id) => decisions[id]);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await risksApi.recordPackage(pkg.id, { signedByName: name.trim(), signedByTitle: title.trim(), signedOn, decisions }, file);
      onRecorded();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Could not record the signature');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Record signature for ${pkg.number}`} size="lg" onClose={onClose}
      footer={<div className="flex items-center justify-between gap-2">
        <p className="text-xs text-danger" role="alert">{error}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !ready}>{busy ? 'Recording…' : 'Record signature'}</Button>
        </div>
      </div>}>
      <p className="mb-4 text-sm text-muted">
        Upload the signed copy and mark what the Authorizing Official decided for each risk. Accepted risks are approved; Not accepted risks are rejected; Not marked risks go back to awaiting acceptance.
      </p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Signed copy (PDF, PNG or JPEG)">
            <input type="file" accept="application/pdf,image/png,image/jpeg" className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <Field label="Authorizing Official name"><Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Title"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Signed on"><Input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} /></Field>
      </div>
      <div className="space-y-3">
        {pkg.risk_ids.map((id) => {
          const r = byId.get(id);
          return (
            <fieldset key={id} className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm">
                <span className="font-mono text-xs text-muted">{r?.ref ?? id}</span>{r ? ` ${r.title}` : ''}
              </legend>
              <div className="flex flex-wrap gap-4">
                {DECISIONS.map((d) => (
                  <label key={d.value} className="flex items-center gap-1.5 text-sm">
                    <input type="radio" name={`decision-${id}`} value={d.value} checked={decisions[id] === d.value}
                      onChange={() => setDecisions((s) => ({ ...s, [id]: d.value }))} />
                    {d.label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Dialog>
  );
}
