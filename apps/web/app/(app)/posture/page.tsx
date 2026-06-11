'use client';
import * as React from 'react';
import { api, ApiError, conmon, type Finding, type ConMonRun } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge, Select } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';
import { ScoreGauge, MiniBars } from '@/components/ui/charts';
import { SeverityBadge } from '@/components/ui/badges';

export default function PosturePage() {
  const { me, can } = useAuth();
  const [score, setScore] = React.useState<{ overall_score: number; grade: string } | null>(null);
  const [findings, setFindings] = React.useState<Finding[] | null>(null);
  const [severity, setSeverity] = React.useState('');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [runs, setRuns] = React.useState<ConMonRun[] | null>(null);

  const load = React.useCallback(() => {
    api.get<{ overall_score: number; grade: string }>('/posture/score').then(setScore).catch(() => {});
    const qs = new URLSearchParams();
    if (severity) qs.set('severity', severity);
    api.get<{ data: Finding[] }>(`/posture/findings?${qs}`).then((r) => setFindings(r.data)).catch(() => setFindings([]));
    conmon.runs().then((r) => setRuns(r.data)).catch(() => setRuns([]));
  }, [severity]);
  React.useEffect(load, [load]);

  const [runningConmon, setRunningConmon] = React.useState(false);
  async function runConMon() {
    setRunningConmon(true);
    try {
      await conmon.run();
      load();
    } finally {
      setRunningConmon(false);
    }
  }

  async function toTicket(f: Finding) {
    setBusyId(f.id);
    setError(null);
    try {
      await api.post(`/posture/findings/${f.id}/to-ticket`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Failed to create ticket');
    } finally {
      setBusyId(null);
    }
  }

  const open = (findings ?? []).filter((f) => !['remediated', 'closed', 'accepted'].includes(f.status));
  const sev = (findings ?? []).reduce<Record<string, number>>((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
  const canManage = can('posture.finding.manage');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security posture</h1>
        <p className="mt-1 text-sm text-muted">
          {me?.plane === 'nexus' ? 'Findings, scoring, and remediation across the customer.' : 'Your organization’s security posture and remediation status.'}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Posture score</CardTitle></CardHeader>
          <CardBody className="flex flex-col items-center">
            {!score ? <Skeleton className="h-40 w-40 rounded-full" /> : (
              <>
                <ScoreGauge score={score.overall_score} size={180} />
                <Badge tone={score.overall_score >= 80 ? 'success' : score.overall_score >= 60 ? 'warning' : 'danger'} className="mt-3">
                  Grade {score.grade}
                </Badge>
              </>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Open findings" value={findings ? open.length : '—'} tone="warning" />
            <StatCard label="Critical" value={sev.critical ?? 0} tone="danger" />
            <StatCard label="High" value={sev.high ?? 0} tone="danger" />
          </div>
          <Card>
            <CardHeader><CardTitle>Severity distribution</CardTitle></CardHeader>
            <CardBody>
              <MiniBars items={[
                { label: 'Critical', value: sev.critical ?? 0, color: 'hsl(var(--danger))' },
                { label: 'High', value: sev.high ?? 0, color: 'hsl(var(--danger))' },
                { label: 'Moderate', value: sev.moderate ?? 0, color: 'hsl(var(--warning))' },
                { label: 'Low', value: sev.low ?? 0, color: 'hsl(var(--brand))' },
                { label: 'Info', value: sev.info ?? 0, color: 'hsl(var(--muted))' },
              ]} />
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Continuous Monitoring */}
      <Card>
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <CardTitle>Continuous Monitoring (ConMon)</CardTitle>
            <p className="mt-0.5 text-[11px] text-muted">NIST 800-137 / FedRAMP — scheduled checks raise findings &amp; remediation tickets.</p>
          </div>
          {canManage && (
            <Button size="sm" variant="outline" onClick={runConMon} disabled={runningConmon}>
              {runningConmon ? 'Running…' : 'Run checks now'}
            </Button>
          )}
        </div>
        <CardBody>
          {!runs ? (
            <Skeleton className="h-20" />
          ) : runs.length === 0 ? (
            <EmptyState title="No ConMon runs yet" description={canManage ? 'Run checks to populate continuous-monitoring history.' : 'Continuous monitoring history will appear here.'} />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {runs.slice(0, 12).map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border border-border bg-surface-2/40 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-fg">{r.name ?? r.check_key}</div>
                    <div className="text-[10px] text-muted">{r.domain} · {new Date(r.ran_at).toLocaleString()}</div>
                  </div>
                  <Badge tone={r.result === 'finding' ? 'danger' : r.result === 'pass' ? 'success' : 'warning'}>{r.result}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b border-border p-4">
          <CardTitle>Findings</CardTitle>
          <Select className="w-44" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="moderate">Moderate</option>
            <option value="low">Low</option>
          </Select>
        </div>
        {error && <p className="px-4 pt-3 text-xs text-danger">{error}</p>}
        <CardBody className="px-0 pt-0">
          {!findings ? (
            <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (
            <DataTable<Finding>
              rows={findings}
              empty={<EmptyState title="No findings" description="Nothing outstanding for this filter." />}
              columns={[
                { key: 'sev', header: 'Severity', render: (f) => <SeverityBadge severity={f.severity} /> },
                { key: 'title', header: 'Finding', render: (f) => <span className="font-medium text-fg">{f.title}</span> },
                { key: 'domain', header: 'Domain', render: (f) => <span className="text-xs text-muted">{f.domain}</span> },
                { key: 'risk', header: 'Risk', render: (f) => <span className="tabular-nums text-xs text-fg">{Math.round(f.risk_score)}</span> },
                { key: 'status', header: 'Status', render: (f) => <Badge>{f.status.replace(/_/g, ' ')}</Badge> },
                { key: 'due', header: 'Remediate by', render: (f) => <span className="text-xs text-muted">{f.remediation_due_at ? new Date(f.remediation_due_at).toLocaleDateString() : '—'}</span> },
                {
                  key: 'action', header: '', render: (f) =>
                    canManage && !f.linked_ticket_id ? (
                      <Button size="sm" variant="outline" disabled={busyId === f.id} onClick={() => toTicket(f)}>
                        {busyId === f.id ? '…' : 'Create ticket'}
                      </Button>
                    ) : f.linked_ticket_id ? <Badge tone="brand">ticketed</Badge> : null,
                },
              ]}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
