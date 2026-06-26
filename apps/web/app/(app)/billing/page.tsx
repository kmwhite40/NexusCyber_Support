'use client';
import * as React from 'react';
import { api, billingApi, type BillingSettings, type BillingUtilization } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Select, Input, Label } from '@/components/ui/primitives';
import { EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { Receipt, Download, Save, AlertTriangle } from 'lucide-react';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);

export default function BillingPage() {
  const { me, can } = useAuth();
  const isAgent = me?.plane === 'nexus';
  const canManage = can('org.manage');

  const [orgs, setOrgs] = React.useState<{ id: string; name: string }[]>([]);
  const [orgId, setOrgId] = React.useState('');
  const [period, setPeriod] = React.useState<{ year: number; month: number } | null>(null);

  const [settings, setSettings] = React.useState<BillingSettings | null>(null);
  const [util, setUtil] = React.useState<BillingUtilization | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // form fields (fee shown in dollars)
  const [plan, setPlan] = React.useState('');
  const [allocation, setAllocation] = React.useState('0');
  const [feeDollars, setFeeDollars] = React.useState('0');
  const [currency, setCurrency] = React.useState('USD');

  // current month default (client-only to avoid hydration mismatch)
  React.useEffect(() => {
    const d = new Date();
    setPeriod({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }, []);
  React.useEffect(() => {
    if (canManage) api.get<{ data: { id: string; name: string }[] }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {});
  }, [canManage]);

  const load = React.useCallback(() => {
    if (!orgId || !period) return;
    setLoading(true);
    Promise.all([billingApi.settings(orgId), billingApi.utilization(orgId, period.year, period.month)])
      .then(([s, u]) => {
        setSettings(s);
        setUtil(u);
        setPlan(s.plan_name);
        setAllocation(String(s.monthly_ticket_allocation));
        setFeeDollars((s.overage_fee_cents / 100).toFixed(2));
        setCurrency(s.currency);
      })
      .catch(() => {
        setSettings(null);
        setUtil(null);
      })
      .finally(() => setLoading(false));
  }, [orgId, period]);
  React.useEffect(load, [load]);

  async function save() {
    if (!orgId) return;
    setSaving(true);
    try {
      await billingApi.saveSettings({
        organizationId: orgId,
        planName: plan.trim() || 'Standard',
        monthlyTicketAllocation: Math.max(0, parseInt(allocation || '0', 10) || 0),
        overageFeeCents: Math.max(0, Math.round((parseFloat(feeDollars || '0') || 0) * 100)),
        currency: (currency || 'USD').toUpperCase(),
      });
      load();
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardBody>
          <EmptyState title="Admins only" description="Billing & utilization is restricted to administrators." />
        </CardBody>
      </Card>
    );
  }

  const overBudget = !!util && util.overage > 0;
  const usePct = util && util.allocation > 0 ? Math.min(100, Math.round((util.used / util.allocation) * 100)) : util && util.used > 0 ? 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing &amp; utilization</h1>
          <p className="mt-1 text-sm text-muted">Per-customer ticket allotment, overage pricing, and monthly statements.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="h-9 w-56" value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Customer">
            <option value="">Select customer…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          {period && (
            <>
              <Select
                className="h-9 w-36"
                value={period.month}
                onChange={(e) => setPeriod((p) => p && { ...p, month: Number(e.target.value) })}
                aria-label="Month"
              >
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
              <Select
                className="h-9 w-24"
                value={period.year}
                onChange={(e) => setPeriod((p) => p && { ...p, year: Number(e.target.value) })}
                aria-label="Year"
              >
                {[period.year - 1, period.year, period.year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </>
          )}
        </div>
      </div>

      {!orgId ? (
        <Card>
          <CardBody>
            <EmptyState title="Select a customer" description="Choose an organization to set its plan and view utilization &amp; billing." />
          </CardBody>
        </Card>
      ) : loading && !util ? (
        <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <>
          {/* Utilization */}
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard label="Tickets used" value={util ? util.used : '—'} tone={overBudget ? 'danger' : 'brand'} />
            <StatCard label="Allotment" value={util ? util.allocation : '—'} tone="accent" />
            <StatCard label="Overage" value={util ? util.overage : '—'} tone={overBudget ? 'danger' : 'success'} />
            <StatCard label="Amount due" value={util ? money(util.amount_cents, util.currency) : '—'} tone={overBudget ? 'warning' : 'accent'} />
          </div>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>This period — {period && `${MONTHS[period.month - 1]} ${period.year}`}</CardTitle>
              {overBudget && (
                <Badge tone="warning"><AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} /> Over allotment</Badge>
              )}
            </CardHeader>
            <CardBody>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted">{util?.used ?? 0} of {util?.allocation ?? 0} tickets</span>
                <span className="text-muted">{usePct}%</span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${overBudget ? 'bg-danger' : 'bg-brand'}`}
                  style={{ width: `${usePct}%` }}
                />
              </div>
              {util && (
                <p className="mt-3 text-sm text-muted">
                  {overBudget ? (
                    <>
                      <span className="font-medium text-fg">{util.overage}</span> ticket{util.overage === 1 ? '' : 's'} over the{' '}
                      <span className="font-medium text-fg">{util.allocation}</span>-ticket allotment at{' '}
                      <span className="font-medium text-fg">{money(util.overage_fee_cents, util.currency)}</span>/ticket ={' '}
                      <span className="font-semibold text-fg">{money(util.amount_cents, util.currency)}</span> due.
                    </>
                  ) : (
                    <>Within the {util.allocation}-ticket allotment — no overage charges this period.</>
                  )}
                </p>
              )}
            </CardBody>
          </Card>

          {/* Plan configuration (per customer) */}
          <Card>
            <CardHeader><CardTitle>Plan &amp; overage pricing</CardTitle></CardHeader>
            <CardBody>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <Label>Plan name</Label>
                  <Input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Standard" />
                </div>
                <div>
                  <Label>Monthly ticket allotment</Label>
                  <Input type="number" min={0} value={allocation} onChange={(e) => setAllocation(e.target.value)} />
                </div>
                <div>
                  <Label>Overage fee (per ticket)</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
                    <Input type="number" min={0} step="0.01" className="pl-6" value={feeDollars} onChange={(e) => setFeeDollars(e.target.value)} />
                  </div>
                </div>
                <div>
                  <Label>Currency</Label>
                  <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="CAD">CAD</option>
                  </Select>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button onClick={save} disabled={saving}>
                  <Save className="h-4 w-4" strokeWidth={1.75} />
                  {saving ? 'Saving…' : 'Save plan'}
                </Button>
                {settings?.updated_at && (
                  <span className="text-xs text-muted">Last updated {new Date(settings.updated_at).toLocaleString()}</span>
                )}
              </div>
            </CardBody>
          </Card>

          {/* Statement */}
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Monthly statement</CardTitle>
              <Button variant="outline" onClick={() => util && openStatement(util)} disabled={!util}>
                <Download className="h-4 w-4" strokeWidth={1.75} />
                Export PDF
              </Button>
            </CardHeader>
            <CardBody>
              <div className="flex items-start gap-3 text-sm text-muted">
                <Receipt className="mt-0.5 h-5 w-5 shrink-0 text-brand" strokeWidth={1.5} />
                <p>
                  Generates a statement for <span className="font-medium text-fg">{util?.organization_name}</span> covering{' '}
                  {period && `${MONTHS[period.month - 1]} ${period.year}`}
                  {overBudget
                    ? <> with <span className="font-medium text-fg">{money(util!.amount_cents, util!.currency)}</span> in overage charges.</>
                    : <> with no overage charges.</>}{' '}
                  Opens a print-ready statement — choose <span className="font-medium text-fg">Save as PDF</span> in the print dialog.
                </p>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

/** Build an M365-style statement and open it print-ready (Save as PDF). */
function openStatement(u: BillingUtilization) {
  const fmt = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: u.currency }).format((cents || 0) / 100);
  const monthName = MONTHS[u.month - 1];
  const periodLabel = `${monthName} ${u.year}`;
  const issued = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const stmtNo = `ANC-${u.organization_id.slice(0, 8).toUpperCase()}-${u.year}${String(u.month).padStart(2, '0')}`;
  const allotmentAmt = fmt(0);
  const overageUnit = fmt(u.overage_fee_cents);
  const overageAmt = fmt(u.amount_cents);
  const total = fmt(u.amount_cents);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Statement ${stmtNo}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#1b2430;background:#f3f5f8;padding:32px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{max-width:800px;margin:0 auto;background:#fff;border:1px solid #e6eaf0;border-radius:8px;overflow:hidden}
  .bar{height:6px;background:linear-gradient(90deg,#2563ef,#0e7490)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;padding:32px 40px 24px}
  .brand{display:flex;align-items:center;gap:10px}
  .mark{width:30px;height:30px;border:3px solid #2563ef;border-radius:7px;position:relative}
  .mark::after{content:"";position:absolute;inset:5px;background:#2563ef;border-radius:3px}
  .brand .nm{font-size:20px;font-weight:700;letter-spacing:-.02em;color:#0a1f44}
  .brand .sub{font-size:11px;color:#64748b;letter-spacing:.04em}
  .doc{text-align:right}
  .doc h1{font-size:24px;font-weight:600;letter-spacing:.12em;color:#0a1f44;text-transform:uppercase}
  .doc .meta{margin-top:8px;font-size:12.5px;color:#475569;line-height:1.8}
  .doc .meta b{color:#0a1f44}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:0 40px 24px}
  .parties .lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:#94a3b8;margin-bottom:6px}
  .parties .v{font-size:14px;color:#1b2430;line-height:1.6}
  .parties .v b{color:#0a1f44;font-size:15px}
  .duebox{margin:0 40px 28px;background:#f0f6ff;border:1px solid #cfe0ff;border-radius:8px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center}
  .duebox .l{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#2563ef;font-weight:600}
  .duebox .a{font-size:26px;font-weight:700;color:#0a1f44}
  table{width:100%;border-collapse:collapse}
  thead th{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;text-align:left;padding:10px 40px;border-bottom:1px solid #e6eaf0;background:#fafbfc}
  thead th.r,tbody td.r{text-align:right}
  tbody td{padding:14px 40px;border-bottom:1px solid #eef1f5;font-size:13.5px;color:#1b2430;vertical-align:top}
  tbody td .desc{font-weight:600;color:#0a1f44}
  tbody td .sub{font-size:12px;color:#64748b;margin-top:2px}
  .totals{padding:16px 40px 8px;margin-left:auto;width:320px}
  .totals .row{display:flex;justify-content:space-between;font-size:13.5px;color:#475569;padding:6px 0}
  .totals .row.tot{border-top:2px solid #0a1f44;margin-top:6px;padding-top:12px;font-size:17px;font-weight:700;color:#0a1f44}
  .usage{margin:8px 40px 0;padding:16px 0;border-top:1px solid #eef1f5;font-size:12.5px;color:#64748b}
  .usage b{color:#0a1f44}
  .foot{padding:24px 40px 32px;border-top:1px solid #e6eaf0;margin-top:16px;font-size:11.5px;color:#94a3b8;line-height:1.7}
  .foot b{color:#475569}
  @media print{body{background:#fff;padding:0}.sheet{border:none;border-radius:0;max-width:none}@page{size:letter;margin:0.5in}}
</style></head>
<body>
  <div class="sheet">
    <div class="bar"></div>
    <div class="head">
      <div class="brand"><span class="mark"></span><div><div class="nm">Anchor</div><div class="sub">by SBS Federal</div></div></div>
      <div class="doc">
        <h1>Statement</h1>
        <div class="meta"><b>No.</b> ${stmtNo}<br><b>Issued</b> ${issued}<br><b>Period</b> ${periodLabel}</div>
      </div>
    </div>
    <div class="parties">
      <div><div class="lbl">Billed to</div><div class="v"><b>${u.organization_name}</b></div></div>
      <div><div class="lbl">Plan</div><div class="v"><b>${u.plan_name}</b><br>${u.allocation} tickets / month included<br>Overage ${overageUnit} / ticket</div></div>
    </div>
    <div class="duebox"><span class="l">Total due</span><span class="a">${total}</span></div>
    <table>
      <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead>
      <tbody>
        <tr>
          <td><div class="desc">${u.plan_name} — monthly ticket allotment</div><div class="sub">${periodLabel} · ${u.allocation} tickets included in plan</div></td>
          <td class="r">${u.allocation}</td><td class="r">Included</td><td class="r">${allotmentAmt}</td>
        </tr>
        <tr>
          <td><div class="desc">Overage tickets</div><div class="sub">Tickets beyond the ${u.allocation}-ticket allotment</div></td>
          <td class="r">${u.overage}</td><td class="r">${overageUnit}</td><td class="r">${overageAmt}</td>
        </tr>
      </tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${overageAmt}</span></div>
      <div class="row tot"><span>Total due</span><span>${total}</span></div>
    </div>
    <div class="usage">Usage summary — <b>${u.used}</b> tickets created in ${periodLabel}; allotment <b>${u.allocation}</b>; overage <b>${u.overage}</b>.</div>
    <div class="foot">
      <b>Anchor by SBS Federal</b> — Government-Cloud Service Desk &amp; Security Operations.<br>
      Computed from ticket activity for the stated period. Questions about this statement? Contact your Anchor administrator.
    </div>
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print()},350)}</script>
</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1180');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
