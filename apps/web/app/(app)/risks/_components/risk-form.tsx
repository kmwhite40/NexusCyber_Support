'use client';
// Create / edit a risk. One form for both, because the assessment is the same act either way.
import * as React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import {
  CATEGORIES, IMPACT_DIMENSIONS, IMPACT_LABELS, humanize, risksApi,
  type FairInputs, type Risk, type RiskWrite,
} from '@/lib/risks';
import { MatrixPicker } from './matrix';

interface State {
  title: string; description: string; cause: string; event: string; consequence: string;
  category: string; threatSource: string; strategy: string; ownerName: string; velocity: string;
  il: number | null; ii: number | null; rl: number | null; ri: number | null; tl: number | null; ti: number | null;
  dims: Record<string, number>;
  fairOn: boolean;
  fair: { lef: [string, string, string]; lm: [string, string, string] };
  reviewDays: string; tags: string; note: string;
}

function initial(r?: Risk | null): State {
  const f = r?.fair_inputs;
  return {
    title: r?.title ?? '', description: r?.description ?? '', cause: r?.cause ?? '', event: r?.event ?? '',
    consequence: r?.consequence ?? '', category: r?.category ?? 'cybersecurity', threatSource: r?.threat_source ?? '',
    strategy: r?.strategy ?? '', ownerName: r?.owner_name ?? '', velocity: r?.velocity ?? '',
    il: r?.inherent_likelihood ?? null, ii: r?.inherent_impact ?? null,
    rl: r?.residual_likelihood ?? null, ri: r?.residual_impact ?? null,
    tl: r?.target_likelihood ?? null, ti: r?.target_impact ?? null,
    dims: { ...(r?.impact_dimensions ?? {}) },
    fairOn: !!f,
    fair: {
      lef: f ? [String(f.lef.min), String(f.lef.likely), String(f.lef.max)] : ['0.1', '0.5', '2'],
      lm: f ? [String(f.lm.min), String(f.lm.likely), String(f.lm.max)] : ['10000', '100000', '1000000'],
    },
    reviewDays: r?.review_frequency_days ? String(r.review_frequency_days) : '',
    tags: (r?.tags ?? []).join(', '), note: '',
  };
}

export function RiskForm({
  organizationId, risk, onClose, onSaved,
}: {
  organizationId: string | undefined;
  risk?: Risk | null;
  onClose: () => void;
  onSaved: (r: Risk) => void;
}) {
  const editing = !!risk;
  const [s, setS] = React.useState<State>(() => initial(risk));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const set = <K extends keyof State>(k: K, v: State[K]) => { setS((p) => ({ ...p, [k]: v })); setDirty(true); };

  const hw = Math.max(0, ...Object.values(s.dims).map(Number));

  function close() {
    if (dirty && !window.confirm('Discard your changes to this risk?')) return;
    onClose();
  }

  function fairInputs(): FairInputs | null {
    if (!s.fairOn) return null;
    const n = (a: [string, string, string]) => ({ min: Number(a[0]), likely: Number(a[1]), max: Number(a[2]) });
    return { lef: n(s.fair.lef), lm: n(s.fair.lm) };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!s.il || !s.ii) { setError('Choose an inherent likelihood and impact on the matrix.'); return; }
    if ((s.tl === null) !== (s.ti === null)) { setError('Set both target likelihood and impact, or neither.'); return; }
    const dims = Object.fromEntries(Object.entries(s.dims).filter(([, v]) => v > 0));
    const body: RiskWrite = {
      title: s.title.trim(),
      description: s.description || null, cause: s.cause || null, event: s.event || null, consequence: s.consequence || null,
      category: s.category as RiskWrite['category'],
      threatSource: s.threatSource || null, strategy: (s.strategy || null) as RiskWrite['strategy'],
      ownerName: s.ownerName || null, velocity: s.velocity || null,
      inherentLikelihood: s.il, inherentImpact: s.ii,
      ...(s.rl && s.ri ? { residualLikelihood: s.rl, residualImpact: s.ri } : {}),
      targetLikelihood: s.tl, targetImpact: s.ti,
      impactDimensions: dims,
      fair: fairInputs(),
      reviewFrequencyDays: s.reviewDays ? Number(s.reviewDays) : null,
      tags: s.tags.split(',').map((t) => t.trim()).filter(Boolean),
      ...(s.note ? { note: s.note } : {}),
    };
    setBusy(true);
    try {
      const saved = editing ? await risksApi.update(risk!.id, body) : await risksApi.create({ ...body, organizationId });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? (err.errors?.map((x) => `${x.field}: ${x.message}`).join('; ') || err.detail) : 'Could not save the risk');
    } finally {
      setBusy(false);
    }
  }

  const formId = React.useId();
  return (
    <Dialog
      title={editing ? `Edit ${risk!.ref}` : 'New risk'}
      onClose={close}
      size="xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-danger" role="alert">{error}</p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
            <Button type="submit" form={formId} disabled={busy || s.title.trim().length < 3}>{busy ? 'Saving…' : editing ? 'Save assessment' : 'Add to register'}</Button>
          </div>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-6">
        <section>
          <Field label="Title"><Input value={s.title} onChange={(e) => set('title', e.target.value)} required minLength={3} maxLength={200} placeholder="e.g. Ransomware via phishing-delivered initial access" /></Field>
          <div className="grid gap-x-4 md:grid-cols-3">
            <Field label="Because of… (cause)"><Textarea className="min-h-[72px]" value={s.cause} onChange={(e) => set('cause', e.target.value)} placeholder="Legacy auth still enabled" /></Field>
            <Field label="…this may happen (event)"><Textarea className="min-h-[72px]" value={s.event} onChange={(e) => set('event', e.target.value)} placeholder="An attacker gains a foothold" /></Field>
            <Field label="…leading to (consequence)"><Textarea className="min-h-[72px]" value={s.consequence} onChange={(e) => set('consequence', e.target.value)} placeholder="Multi-day outage" /></Field>
          </div>
          <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Category">
              <Select value={s.category} onChange={(e) => set('category', e.target.value)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </Select>
            </Field>
            <Field label="Threat source">
              <Select value={s.threatSource} onChange={(e) => set('threatSource', e.target.value)}>
                <option value="">—</option>
                {['adversarial', 'accidental', 'structural', 'environmental'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </Select>
            </Field>
            <Field label="Response strategy">
              <Select value={s.strategy} onChange={(e) => set('strategy', e.target.value)}>
                <option value="">Not decided</option>
                {['mitigate', 'transfer', 'avoid'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
                {editing && s.strategy === 'accept' && <option value="accept">Accept</option>}
              </Select>
            </Field>
            <Field label="Velocity" hint="How fast it hits once triggered">
              <Select value={s.velocity} onChange={(e) => set('velocity', e.target.value)}>
                <option value="">—</option>
                {['slow', 'moderate', 'rapid', 'immediate'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </Select>
            </Field>
          </div>
        </section>

        <section>
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Assessment</h4>
          <div className="grid gap-6 md:grid-cols-3">
            <MatrixPicker label="Inherent — before controls" l={s.il} i={s.ii} onChange={(l, i) => { set('il', l); set('ii', i); }} />
            <MatrixPicker label="Residual — with current controls" l={s.rl ?? s.il} i={s.ri ?? s.ii} onChange={(l, i) => { set('rl', l); set('ri', i); }} />
            <div>
              <MatrixPicker label="Target — after treatment" l={s.tl} i={s.ti} onChange={(l, i) => { set('tl', l); set('ti', i); }} />
              {s.tl && <button type="button" className="mt-1 text-[11px] text-muted underline" onClick={() => { set('tl', null); set('ti', null); }}>Clear target</button>}
            </div>
          </div>
          {!s.rl && s.il && <p className="mt-2 text-[11px] text-muted">Residual starts at inherent until you credit controls.</p>}
        </section>

        <details className="rounded-lg border border-border p-4" open={hw > 0}>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted">
            Impact by dimension {hw > 0 && <span className="ml-2 normal-case tracking-normal text-fg">high-water mark: {IMPACT_LABELS[hw - 1]} ({hw}) — overrides inherent impact</span>}
          </summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {IMPACT_DIMENSIONS.map((d) => (
              <Field key={d} label={humanize(d)}>
                <Select value={String(s.dims[d] ?? 0)} onChange={(e) => set('dims', { ...s.dims, [d]: Number(e.target.value) })}>
                  <option value="0">N/A</option>
                  {IMPACT_LABELS.map((l, i) => <option key={l} value={i + 1}>{i + 1} · {l}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        </details>

        <details className="rounded-lg border border-border p-4" open={s.fairOn}>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted">Quantify (FAIR)</summary>
          <label className="mt-3 flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={s.fairOn} onChange={(e) => set('fairOn', e.target.checked)} className="accent-[hsl(var(--brand))]" />
            Estimate annualized loss with a Monte Carlo simulation
          </label>
          {s.fairOn && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <RangeInputs label="Loss events per year" value={s.fair.lef} step="0.01" onChange={(v) => set('fair', { ...s.fair, lef: v })} />
              <RangeInputs label="Loss per event (USD)" value={s.fair.lm} step="1000" onChange={(v) => set('fair', { ...s.fair, lm: v })} />
              <p className="text-[11px] text-muted md:col-span-2">Minimum / most likely / maximum, as calibrated estimates. 10,000 PERT-distributed draws; results are reproducible.</p>
            </div>
          )}
        </details>

        <section className="grid gap-x-4 sm:grid-cols-3">
          <Field label="Owner (name)" hint="Accountable person, inside or outside Nexus"><Input value={s.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></Field>
          <Field label="Review every (days)" hint="Blank = by rating (30–365)"><Input type="number" min={1} max={1095} value={s.reviewDays} onChange={(e) => set('reviewDays', e.target.value)} /></Field>
          <Field label="Tags" hint="Comma separated"><Input value={s.tags} onChange={(e) => set('tags', e.target.value)} placeholder="cmmc, board" /></Field>
        </section>
        <Field label="Description"><Textarea value={s.description} onChange={(e) => set('description', e.target.value)} /></Field>
        {editing && <Field label="Assessment note" hint="Recorded in the risk's history"><Input value={s.note} onChange={(e) => set('note', e.target.value)} placeholder="Why did the score change?" /></Field>}
      </form>
    </Dialog>
  );
}

function RangeInputs({ label, value, step, onChange }: { label: string; value: [string, string, string]; step: string; onChange: (v: [string, string, string]) => void }) {
  const names = ['Min', 'Most likely', 'Max'];
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-muted">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {value.map((v, idx) => (
          <Input key={idx} type="number" min={0} step={step} value={v} aria-label={`${label} — ${names[idx]}`} placeholder={names[idx]}
            onChange={(e) => { const next = [...value] as [string, string, string]; next[idx] = e.target.value; onChange(next); }} />
        ))}
      </div>
    </fieldset>
  );
}
