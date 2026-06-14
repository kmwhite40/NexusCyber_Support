// Analytics aggregation — reproduces the metrics of the IT Helpdesk Power BI dashboard
// (overview + agent analysis) natively over our ticket data. RLS-scoped: customers see
// their org; agents see assigned orgs. SLA threshold for "within SLA" is <= 3 days,
// matching the source dashboard's definition.
import { withOrgContext } from '../db/pool.js';
import { orgContextFor } from '../auth/principal.js';
import { can } from '../authz/pdp.js';
import { Errors } from '../errors.js';
import type { Principal } from '../types.js';
import { controlCoverage } from './compliance.js';

const SLA_DAYS = 3;

interface Row {
  id: string;
  organization_id: string;
  category: string | null;
  priority: string | null;
  severity: string | null;
  klass: string | null; // 'request' | 'error'
  created_at: string;
  resolved_at: string | null;
  satisfaction_score: number | null;
  agent_id: string | null;
  agent_name: string | null;
  res_days: number | null;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}
function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

export async function overview(actor: Principal, orgId?: string) {
  if (!can(actor, 'report.read.operational') && !can(actor, 'report.read.customer')) {
    throw Errors.forbidden('missing reporting permission');
  }

  const rows = await withOrgContext(orgContextFor(actor), async (sql) => {
    const params: unknown[] = [];
    let where = '';
    if (orgId) {
      params.push(orgId);
      where = 'WHERE t.organization_id = $1';
    }
    const res = await sql.query(
      `SELECT t.id, t.organization_id, t.category, t.priority, t.severity,
              t.custom_fields->>'class' AS klass,
              t.created_at, t.resolved_at, t.satisfaction_score,
              t.assigned_agent_id AS agent_id, u.display_name AS agent_name,
              CASE WHEN t.resolved_at IS NOT NULL
                   THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 86400.0 END AS res_days
         FROM tickets t
         LEFT JOIN users u ON u.id = t.assigned_agent_id
         ${where}`,
      params,
    );
    return res.rows as Row[];
  });

  const total = rows.length;
  const resolved = rows.filter((r) => r.res_days != null);
  const withinSla = rows.filter((r) => r.res_days != null && r.res_days <= SLA_DAYS);
  const ratings = rows.filter((r) => r.satisfaction_score != null).map((r) => r.satisfaction_score as number);

  // --- KPIs ---
  const kpis = {
    totalTickets: total,
    avgResolutionDays: avg(resolved.map((r) => r.res_days as number)),
    withinSlaPct: pct(withinSla.length, total),
    avgRating: avg(ratings),
    totalAgents: new Set(rows.filter((r) => r.agent_id).map((r) => r.agent_id)).size,
  };

  // --- Volume by year (with YoY for headline) ---
  const yearMap = new Map<number, number>();
  for (const r of rows) {
    const y = new Date(r.created_at).getUTCFullYear();
    yearMap.set(y, (yearMap.get(y) ?? 0) + 1);
  }
  const volumeByYear = [...yearMap.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
  const lastYear = volumeByYear.at(-1);
  const prevYear = volumeByYear.at(-2);
  const yoyTicketsPct = lastYear && prevYear ? pct(lastYear.count - prevYear.count, prevYear.count) : 0;

  // --- By category ---
  const catAgg = new Map<string, { total: number; resDays: number[]; within: number }>();
  for (const r of rows) {
    const c = r.category ?? 'Other';
    const a = catAgg.get(c) ?? { total: 0, resDays: [], within: 0 };
    a.total++;
    if (r.res_days != null) {
      a.resDays.push(r.res_days);
      if (r.res_days <= SLA_DAYS) a.within++;
    }
    catAgg.set(c, a);
  }
  const byCategory = [...catAgg.entries()]
    .map(([category, a]) => ({ category, total: a.total, avgResolutionDays: avg(a.resDays), withinSlaPct: pct(a.within, a.total) }))
    .sort((x, y) => y.total - x.total);

  // --- By priority / severity (donuts) ---
  const countBy = (key: keyof Row) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = (r[key] as string | null) ?? 'Unassigned';
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  };
  const byPriority = countBy('priority');
  const bySeverity = countBy('severity');

  // --- Issue breakdown (grouped by class -> category) ---
  const classes: Array<'request' | 'error'> = ['request', 'error'];
  const issueBreakdown = classes.map((klass) => {
    const inClass = rows.filter((r) => (r.klass ?? 'request') === klass);
    const byCat = new Map<string, { total: number; resDays: number[]; within: number }>();
    for (const r of inClass) {
      const c = r.category ?? 'Other';
      const a = byCat.get(c) ?? { total: 0, resDays: [], within: 0 };
      a.total++;
      if (r.res_days != null) {
        a.resDays.push(r.res_days);
        if (r.res_days <= SLA_DAYS) a.within++;
      }
      byCat.set(c, a);
    }
    return {
      klass: klass === 'request' ? 'IT Request' : 'IT Error',
      total: inClass.length,
      pctOfGrand: pct(inClass.length, total),
      categories: [...byCat.entries()]
        .map(([category, a]) => ({
          category,
          total: a.total,
          pctOfClass: pct(a.total, inClass.length),
          avgResolutionDays: avg(a.resDays),
          withinSlaPct: pct(a.within, a.total),
        }))
        .sort((x, y) => y.total - x.total),
    };
  });

  // --- Agent performance ---
  const agentAgg = new Map<string, { name: string; tickets: number; resDays: number[]; within: number; ratings: number[] }>();
  for (const r of rows) {
    if (!r.agent_id) continue;
    const a = agentAgg.get(r.agent_id) ?? { name: r.agent_name ?? 'Unknown', tickets: 0, resDays: [], within: 0, ratings: [] };
    a.tickets++;
    if (r.res_days != null) {
      a.resDays.push(r.res_days);
      if (r.res_days <= SLA_DAYS) a.within++;
    }
    if (r.satisfaction_score != null) a.ratings.push(r.satisfaction_score);
    agentAgg.set(r.agent_id, a);
  }
  const agents = [...agentAgg.entries()].map(([id, a]) => ({
    agentId: id,
    name: a.name,
    tickets: a.tickets,
    avgResolutionDays: avg(a.resDays),
    withinSlaPct: pct(a.within, a.tickets),
    avgRating: avg(a.ratings),
  }));
  const byTickets = [...agents].sort((x, y) => y.tickets - x.tickets);
  const byRating = [...agents].filter((a) => a.avgRating > 0).sort((x, y) => y.avgRating - x.avgRating);

  // --- Scatter: resolution time vs avg rating (binned by integer day) ---
  const binMap = new Map<number, { ratings: number[]; tickets: number }>();
  for (const r of resolved) {
    if (r.satisfaction_score == null) continue;
    const bin = Math.round(r.res_days as number);
    const b = binMap.get(bin) ?? { ratings: [], tickets: 0 };
    b.ratings.push(r.satisfaction_score);
    b.tickets++;
    binMap.set(bin, b);
  }
  const scatter = [...binMap.entries()]
    .map(([resolutionDays, b]) => ({ resolutionDays, avgRating: avg(b.ratings), tickets: b.tickets }))
    .sort((a, b) => a.resolutionDays - b.resolutionDays);

  return {
    kpis,
    yoyTicketsPct,
    volumeByYear,
    byCategory,
    byPriority,
    bySeverity,
    issueBreakdown,
    agents: byTickets,
    topRated: byRating.slice(0, 5),
    worstRated: [...byRating].reverse().slice(0, 5),
    topByTickets: byTickets.slice(0, 5),
    bottomByTickets: [...byTickets].reverse().slice(0, 5),
    scatter,
  };
}

/**
 * Operational KPI snapshot for the enterprise dashboards: live backlog, opened-vs-
 * closed time series, SLA attainment (from sla_instances), and backlog breakdowns.
 * RLS-scoped via withOrgContext; `orgId` narrows to one customer (agents only).
 * `days` is clamped server-side and inlined into generate_series (safe integer).
 */
export async function operationalKpis(actor: Principal, orgId?: string, days = 30) {
  if (!can(actor, 'report.read.operational') && !can(actor, 'report.read.customer')) {
    throw Errors.forbidden('missing reporting permission');
  }
  const d = Math.min(Math.max(Math.floor(Number(days) || 30), 7), 180);
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const p: unknown[] = [];
    let f = '';
    if (orgId) { p.push(orgId); f = 'AND t.organization_id = $1'; }

    const summary = (await sql.query(
      `SELECT
         count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open,
         count(*) FILTER (WHERE status NOT IN ('resolved','closed') AND priority='P1')::int AS open_p1,
         count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS opened_today,
         count(*) FILTER (WHERE resolved_at >= date_trunc('day', now()))::int AS closed_today,
         count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS opened_week,
         count(*) FILTER (WHERE resolved_at >= date_trunc('week', now()))::int AS closed_week,
         coalesce(round(avg(EXTRACT(EPOCH FROM (resolved_at - created_at))/86400.0)
           FILTER (WHERE resolved_at IS NOT NULL), 2), 0)::float AS mttr_days,
         coalesce(round(avg(satisfaction_score) FILTER (WHERE satisfaction_score IS NOT NULL), 2), 0)::float AS csat
       FROM tickets t WHERE 1=1 ${f}`,
      p,
    )).rows[0];

    const trend = (await sql.query(
      `WITH days AS (
         SELECT generate_series(date_trunc('day', now()) - interval '${d - 1} days',
                                date_trunc('day', now()), interval '1 day') AS d)
       SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
         (SELECT count(*) FROM tickets t WHERE date_trunc('day', t.created_at) = days.d ${f})::int AS opened,
         (SELECT count(*) FROM tickets t WHERE date_trunc('day', t.resolved_at) = days.d ${f})::int AS closed
       FROM days ORDER BY days.d`,
      p,
    )).rows;

    const slaRow = (await sql.query(
      `SELECT
         count(*) FILTER (WHERE i.metric='response' AND i.state='met')::int AS resp_met,
         count(*) FILTER (WHERE i.metric='response' AND i.state='breached')::int AS resp_breached,
         count(*) FILTER (WHERE i.metric='resolution' AND i.state='met')::int AS resn_met,
         count(*) FILTER (WHERE i.metric='resolution' AND i.state='breached')::int AS resn_breached
       FROM sla_instances i JOIN tickets t ON t.id = i.ticket_id WHERE 1=1 ${f}`,
      p,
    )).rows[0];
    const aPct = (met: number, br: number) => (met + br > 0 ? Math.round((met / (met + br)) * 100) : 100);
    const sla = {
      responseMet: slaRow.resp_met, responseBreached: slaRow.resp_breached,
      resolutionMet: slaRow.resn_met, resolutionBreached: slaRow.resn_breached,
      responseAttainmentPct: aPct(slaRow.resp_met, slaRow.resp_breached),
      resolutionAttainmentPct: aPct(slaRow.resn_met, slaRow.resn_breached),
      overallAttainmentPct: aPct(slaRow.resp_met + slaRow.resn_met, slaRow.resp_breached + slaRow.resn_breached),
    };

    const byStatus = (await sql.query(
      `SELECT status AS label, count(*)::int AS count FROM tickets t
        WHERE status NOT IN ('resolved','closed') ${f} GROUP BY status ORDER BY 2 DESC`, p)).rows;
    const byPriority = (await sql.query(
      `SELECT priority AS label, count(*)::int AS count FROM tickets t
        WHERE status NOT IN ('resolved','closed') ${f} GROUP BY priority ORDER BY 1`, p)).rows;
    const byAge = (await sql.query(
      `SELECT label, count(*)::int AS count FROM (
         SELECT CASE
           WHEN now()-created_at < interval '1 day'  THEN '< 1 day'
           WHEN now()-created_at < interval '3 days' THEN '1-3 days'
           WHEN now()-created_at < interval '7 days' THEN '3-7 days'
           ELSE '> 7 days' END AS label,
           CASE WHEN now()-created_at < interval '1 day' THEN 1
                WHEN now()-created_at < interval '3 days' THEN 2
                WHEN now()-created_at < interval '7 days' THEN 3 ELSE 4 END AS ord
         FROM tickets t WHERE status NOT IN ('resolved','closed') ${f}) s
       GROUP BY label, ord ORDER BY ord`, p)).rows;

    return { days: d, summary, trend, sla, byStatus, byPriority, byAge };
  });
}

// ---- MSP customer portfolio: per-org snapshot (agents/operational only) ----
export async function customerPortfolio(actor: Principal) {
  if (!can(actor, 'report.read.operational')) throw Errors.forbidden('missing operational reporting permission');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const rows = (await sql.query(
      `SELECT o.id, o.name,
         count(t.id) FILTER (WHERE t.status NOT IN ('resolved','closed'))::int AS open,
         count(t.id) FILTER (WHERE t.status NOT IN ('resolved','closed') AND t.priority='P1')::int AS open_p1,
         count(t.id) FILTER (WHERE t.created_at >= now()-interval '7 days')::int AS opened_7d,
         count(t.id) FILTER (WHERE t.resolved_at >= now()-interval '7 days')::int AS closed_7d,
         coalesce(round(avg(t.satisfaction_score) FILTER (WHERE t.satisfaction_score IS NOT NULL),2),0)::float AS csat
       FROM organizations o
       LEFT JOIN tickets t ON t.organization_id = o.id
       WHERE o.id <> '00000000-0000-0000-0000-000000000000'
       GROUP BY o.id, o.name ORDER BY open DESC, o.name`,
    )).rows;
    const sla = (await sql.query(
      `SELECT t.organization_id AS org,
         count(*) FILTER (WHERE i.state='met')::int AS met,
         count(*) FILTER (WHERE i.state='breached')::int AS breached
       FROM sla_instances i JOIN tickets t ON t.id=i.ticket_id GROUP BY t.organization_id`,
    )).rows;
    const slaMap = new Map(sla.map((r: any) => [r.org, r]));
    return rows.map((r: any) => {
      const s: any = slaMap.get(r.id);
      const met = s?.met ?? 0, br = s?.breached ?? 0;
      return { ...r, slaAttainmentPct: met + br > 0 ? Math.round((met / (met + br)) * 100) : 100 };
    });
  });
}

// ---- Posture + compliance summary for one org ----
export async function postureCompliance(actor: Principal, orgId: string) {
  if (!can(actor, 'posture.read')) throw Errors.forbidden('missing posture permission');
  const data = await withOrgContext(orgContextFor(actor), async (sql) => {
    const f = orgId ? 'AND organization_id = $1' : '';
    const p = orgId ? [orgId] : [];
    const sev = (await sql.query(
      `SELECT severity AS label, count(*)::int AS count FROM posture_findings
        WHERE status NOT IN ('remediated','accepted') ${f} GROUP BY severity`, p)).rows;
    const totals = (await sql.query(
      `SELECT
         count(*) FILTER (WHERE status NOT IN ('remediated','accepted'))::int AS open,
         count(*) FILTER (WHERE status='remediated')::int AS remediated,
         count(*) FILTER (WHERE status NOT IN ('remediated','accepted') AND remediation_due_at < now())::int AS overdue,
         count(*) FILTER (WHERE status NOT IN ('remediated','accepted') AND severity IN ('critical','high'))::int AS open_high
       FROM posture_findings WHERE 1=1 ${f}`, p)).rows[0];
    const conmon = (await sql.query(
      `SELECT result AS label, count(*)::int AS count FROM (
         SELECT DISTINCT ON (check_key) check_key, result FROM conmon_runs
          WHERE 1=1 ${f} ORDER BY check_key, ran_at DESC) latest GROUP BY result`, p)).rows;
    return { sev, totals, conmon };
  });
  // Compliance control coverage (reuses the compliance engine), aggregated by family.
  let compliance: { families: Array<{ family: string; satisfied: number; partial: number; gap: number }>; satisfiedPct: number } = { families: [], satisfiedPct: 0 };
  if (orgId && can(actor, 'compliance.read')) {
    const controls = await controlCoverage(actor, orgId);
    const fam = new Map<string, { family: string; satisfied: number; partial: number; gap: number }>();
    for (const c of controls) {
      const e = fam.get(c.family) ?? { family: c.family, satisfied: 0, partial: 0, gap: 0 };
      e[c.status as 'satisfied' | 'partial' | 'gap'] += 1;
      fam.set(c.family, e);
    }
    const sat = controls.filter((c) => c.status === 'satisfied').length;
    compliance = {
      families: [...fam.values()].sort((a, b) => a.family.localeCompare(b.family)),
      satisfiedPct: controls.length ? Math.round((sat / controls.length) * 100) : 0,
    };
  }
  return { ...data, compliance };
}

// ---- On-call + change operations summary (agents/operational only) ----
export async function opsSummary(actor: Principal, orgId?: string) {
  if (!can(actor, 'report.read.operational')) throw Errors.forbidden('missing operational reporting permission');
  return withOrgContext(orgContextFor(actor), async (sql) => {
    const of = orgId ? 'AND p.organization_id = $1' : '';
    const cp = orgId ? [orgId] : [];
    const pages = (await sql.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE p.state='acknowledged')::int AS acknowledged,
         count(*) FILTER (WHERE p.state='escalated')::int AS escalated,
         count(*) FILTER (WHERE p.state IN ('created','notified'))::int AS open,
         count(*) FILTER (WHERE p.created_at >= now()-interval '7 days')::int AS last_7d
       FROM oncall_pages p WHERE 1=1 ${of}`, cp)).rows[0];
    const mtta = (await sql.query(
      `SELECT coalesce(round(avg(EXTRACT(EPOCH FROM (a.acked_at - p.created_at))/60.0)::numeric,1),0)::float AS mtta_min
         FROM oncall_acknowledgements a JOIN oncall_pages p ON p.id=a.page_id WHERE 1=1 ${of}`, cp)).rows[0];
    const cf = orgId ? 'AND organization_id = $1' : '';
    const byType = (await sql.query(
      `SELECT change_type AS label, count(*)::int AS count FROM changes WHERE 1=1 ${cf} GROUP BY change_type`, cp)).rows;
    const changeTotals = (await sql.query(
      `SELECT
         count(*) FILTER (WHERE status IN ('cab_review'))::int AS in_cab,
         count(*) FILTER (WHERE status IN ('approved','scheduled'))::int AS approved,
         count(*) FILTER (WHERE status='scheduled' AND window_start >= now())::int AS upcoming,
         count(*) FILTER (WHERE status='rejected')::int AS rejected,
         count(*) FILTER (WHERE status='closed')::int AS closed
       FROM changes WHERE 1=1 ${cf}`, cp)).rows[0];
    return { pages: { ...pages, mttaMin: mtta.mtta_min }, change: { byType, ...changeTotals } };
  });
}
