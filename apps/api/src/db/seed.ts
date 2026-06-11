// Seed roles, permissions, demo organizations, users, tickets, and posture findings.
// Idempotent: safe to re-run. Uses the owner connection (bypasses RLS to bootstrap).
import { withSystemContext } from './pool.js';
import { logger } from '../logger.js';

// ---- Permission catalog (subset of docs/nexus/01 §C.5 used by this build) ----
const PERMISSIONS: Array<[string, string]> = [
  ['ticket.create', 'ticket'],
  ['ticket.read.own', 'ticket'],
  ['ticket.read.organization', 'ticket'],
  ['ticket.read.all_assigned_customers', 'ticket'],
  ['ticket.update', 'ticket'],
  ['ticket.assign', 'ticket'],
  ['ticket.escalate', 'ticket'],
  ['ticket.comment', 'ticket'],
  ['ticket.comment.own', 'ticket'],
  ['posture.read', 'posture'],
  ['posture.write', 'posture'],
  ['posture.finding.manage', 'posture'],
  ['posture.approve_exception', 'posture'],
  ['posture.request_exception', 'posture'],
  ['customer.admin.manage_users', 'customer_admin'],
  ['audit.read', 'audit'],
  ['report.read.operational', 'reporting'],
  ['report.read.customer', 'reporting'],
  ['admin.superuser', 'platform_admin'],
];

// ---- Roles -> permission keys ----
const ROLES: Record<string, { plane: 'nexus' | 'customer'; perms: string[] }> = {
  // Nexus plane
  Tier1: { plane: 'nexus', perms: ['ticket.create', 'ticket.read.all_assigned_customers', 'ticket.update', 'ticket.comment'] },
  Tier2: {
    plane: 'nexus',
    perms: [
      'ticket.create', 'ticket.read.all_assigned_customers', 'ticket.update', 'ticket.comment',
      'ticket.assign', 'ticket.escalate', 'posture.read', 'report.read.operational',
    ],
  },
  SecurityAnalyst: {
    plane: 'nexus',
    perms: ['ticket.create', 'ticket.read.all_assigned_customers', 'posture.read', 'posture.write', 'posture.finding.manage', 'audit.read'],
  },
  ServiceDeskManager: {
    plane: 'nexus',
    perms: ['ticket.read.all_assigned_customers', 'ticket.assign', 'ticket.update', 'ticket.comment', 'report.read.operational', 'customer.admin.manage_users', 'audit.read'],
  },
  // Customer plane
  OrgAdmin: { plane: 'customer', perms: ['ticket.create', 'ticket.read.organization', 'ticket.comment', 'posture.read', 'posture.request_exception', 'customer.admin.manage_users', 'report.read.customer', 'audit.read'] },
  EndUser: { plane: 'customer', perms: ['ticket.create', 'ticket.read.own', 'ticket.comment.own', 'ticket.comment'] },
  SecurityContact: { plane: 'customer', perms: ['ticket.read.organization', 'ticket.comment', 'posture.read', 'posture.request_exception', 'report.read.customer'] },
};

async function run() {
  await withSystemContext(async (sql) => {
    // Permissions
    for (const [key, domain] of PERMISSIONS) {
      await sql.query(
        `INSERT INTO permissions (key, domain) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
        [key, domain],
      );
    }

    // Roles + role_permissions
    const roleIds: Record<string, string> = {};
    for (const [key, def] of Object.entries(ROLES)) {
      const { rows } = await sql.query(
        `INSERT INTO roles (key, plane) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET plane=EXCLUDED.plane RETURNING id`,
        [key, def.plane],
      );
      const roleId = rows[0].id;
      roleIds[key] = roleId;
      await sql.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId]);
      for (const perm of def.perms) {
        await sql.query(
          'INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [roleId, perm],
        );
      }
    }

    // Organizations: Acme (commercial), Globex (commercial), Beta Gov (gcchigh)
    const orgs: Record<string, string> = {};
    for (const [name, cloud, domain] of [
      ['Acme', 'commercial', 'acme.example.com'],
      ['Globex', 'commercial', 'globex.example.com'],
      ['BetaGov', 'gcchigh', 'betagov.example.us'],
    ] as const) {
      const found = await sql.query('SELECT id FROM organizations WHERE name=$1', [name]);
      let orgId: string;
      if (found.rows[0]) {
        orgId = found.rows[0].id;
      } else {
        const { rows } = await sql.query(
          `INSERT INTO organizations (name, cloud, enclave_id, status)
           VALUES ($1,$2,$3,'active') RETURNING id`,
          [name, cloud, cloud === 'gcchigh' ? 'gov' : 'commercial'],
        );
        orgId = rows[0].id;
      }
      orgs[name] = orgId;
      await sql.query(
        `INSERT INTO organization_domains (organization_id, domain, verified_at, verification_method)
         VALUES ($1,$2, now(),'seed') ON CONFLICT (domain) DO NOTHING`,
        [orgId, domain],
      );
      const hasProfile = await sql.query('SELECT 1 FROM posture_profiles WHERE organization_id=$1', [orgId]);
      if (!hasProfile.rows[0]) {
        await sql.query(`INSERT INTO posture_profiles (organization_id, scope_type) VALUES ($1,'org')`, [orgId]);
      }
    }

    // Helper to upsert a user with role assignment.
    async function upsertUser(
      plane: 'nexus' | 'customer',
      email: string,
      displayName: string,
      orgName: string | null,
      roleKey: string,
    ) {
      const orgId = orgName ? orgs[orgName] : null;
      const { rows } = await sql.query(
        `INSERT INTO users (plane, organization_id, email, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (plane, email) DO UPDATE SET display_name=EXCLUDED.display_name
         RETURNING id`,
        [plane, orgId, email, displayName],
      );
      const userId = rows[0].id;
      // Nexus agents are assigned to a set of customer orgs (cross-customer scope).
      if (plane === 'nexus') {
        for (const customerOrg of [orgs.Acme, orgs.Globex]) {
          await sql.query(
            `INSERT INTO role_assignments (user_id, role_id, organization_id)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [userId, roleIds[roleKey], customerOrg],
          );
        }
      } else {
        await sql.query(
          `INSERT INTO role_assignments (user_id, role_id, organization_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [userId, roleIds[roleKey], orgId],
        );
      }
      return userId;
    }

    // Nexus agents (no password -> dev login)
    await upsertUser('nexus', 'agent@nexus.example.com', 'Avery Agent (Tier 2)', null, 'Tier2');
    await upsertUser('nexus', 'manager@nexus.example.com', 'Morgan Manager', null, 'ServiceDeskManager');
    await upsertUser('nexus', 'analyst@nexus.example.com', 'Sam Analyst (Security)', null, 'SecurityAnalyst');

    // A pool of desk agents so the analytics agent-leaderboards have data.
    const agentNames = [
      'Mata Lucero', 'Aldo Carrillo', 'Galindo Guadalupe', 'Ramon Macias', 'Alfonso Barraza',
      'Aurelio Tanori', 'Diana Rojo', 'Isela Leyva', 'Segura Garcia', 'Yomara Aqudelo',
    ];
    const agentIds: string[] = [];
    for (let i = 0; i < agentNames.length; i++) {
      const email = `desk${i + 1}@nexus.example.com`;
      const id = await upsertUser('nexus', email, agentNames[i], null, i % 2 === 0 ? 'Tier1' : 'Tier2');
      agentIds.push(id);
    }

    // Customer users (no password -> dev login; registration creates password users)
    const acmeUser = await upsertUser('customer', 'user@acme.example.com', 'Alex User', 'Acme', 'EndUser');
    await upsertUser('customer', 'admin@acme.example.com', 'Dana Admin', 'Acme', 'OrgAdmin');
    await upsertUser('customer', 'security@acme.example.com', 'Riley Security', 'Acme', 'SecurityContact');
    await upsertUser('customer', 'admin@globex.example.com', 'Pat Globex', 'Globex', 'OrgAdmin');

    // Demo tickets for Acme + synthetic historical set powering the analytics dashboard
    // (modeled on the IT Helpdesk Power BI dataset: categories, request/error class,
    // priority/severity mix, multi-year growth, per-agent resolution & satisfaction).
    const existing = await sql.query("SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1", [orgs.Acme]);
    if (existing.rows[0].n === 0) {
      for (const [num, subject, priority, status] of [
        ['ACME-000001', 'Cannot access email on mobile', 'P2', 'in_progress'],
        ['ACME-000002', 'Request: new laptop for hire', 'P3', 'assigned'],
        ['ACME-000003', 'VPN drops every few minutes', 'P2', 'triage'],
      ] as const) {
        await sql.query(
          `INSERT INTO tickets (organization_id, ticket_number, type, requester_id, source_channel, subject, priority, status, response_due_at, resolution_due_at)
           VALUES ($1,$2,'incident',$3,'portal',$4,$5,$6, now()+interval '1 hour', now()+interval '8 hours')`,
          [orgs.Acme, num, acmeUser, subject, priority, status],
        );
      }

      // ---- Synthetic historical tickets ----
      const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
      const weighted = <T,>(pairs: ReadonlyArray<readonly [T, number]>): T => {
        const total = pairs.reduce((s, [, w]) => s + w, 0);
        let r = Math.random() * total;
        for (const [v, w] of pairs) {
          if ((r -= w) <= 0) return v;
        }
        return pairs[0][0];
      };
      // category -> typical resolution time (days) mean. Login Access resolves fast,
      // System/Hardware slow (mirrors the source insights).
      const categories = [
        ['System', 0.4, 7.5],
        ['Login Access', 0.3, 0.33],
        ['Software', 0.2, 5.0],
        ['Hardware', 0.1, 6.5],
      ] as const;
      const years: ReadonlyArray<readonly [number, number]> = [
        [2016, 13], [2017, 15], [2018, 19], [2019, 21], [2020, 29],
      ]; // year -> relative volume weight (growth trend)

      const batch: string[] = [];
      const values: unknown[] = [];
      let seq = 1000;
      const flush = async () => {
        if (!batch.length) return;
        await sql.query(`INSERT INTO tickets
          (organization_id, ticket_number, type, requester_id, assigned_agent_id, source_channel,
           subject, category, priority, severity, status, custom_fields, satisfaction_score,
           created_at, resolved_at)
          VALUES ${batch.join(',')}`, values);
        batch.length = 0;
        values.length = 0;
      };

      const N = 450;
      for (let i = 0; i < N; i++) {
        const [category, , resMean] = pick(categories);
        const klass = weighted([['request', 75], ['error', 25]] as const);
        const priority = weighted([['P1', 36], ['P2', 16], ['P3', 17], ['P4', 0.01]] as const);
        const severity = weighted([['Sev2', 5], ['Sev3', 89]] as const);
        const agentId = pick(agentIds);
        const year = weighted(years);
        const month = Math.floor(Math.random() * 12);
        const day = 1 + Math.floor(Math.random() * 27);
        const created = new Date(Date.UTC(year, month, day, 9));
        // resolution time ~ mean with spread; satisfaction inversely related to res time
        const resDays = Math.max(0.05, resMean * (0.5 + Math.random()));
        const resolved = new Date(created.getTime() + resDays * 86400000);
        const sat = Math.max(1, Math.min(5, Math.round(5 - resDays / 4 + (Math.random() - 0.5))));

        const base = values.length;
        batch.push(
          `($${base + 1},$${base + 2},'incident',$${base + 3},$${base + 4},'portal',$${base + 5},$${base + 6},$${base + 7},$${base + 8},'closed',$${base + 9},$${base + 10},$${base + 11},$${base + 12})`,
        );
        values.push(
          orgs.Acme,
          `ACME-${String(++seq).padStart(6, '0')}`,
          acmeUser,
          agentId,
          `${category} issue: ${klass === 'error' ? 'fault' : 'request'} #${seq}`,
          category,
          priority,
          severity,
          JSON.stringify({ class: klass }),
          sat,
          created.toISOString(),
          resolved.toISOString(),
        );
        if (batch.length >= 100) await flush();
      }
      await flush();
    }

    // Demo posture findings for Acme
    const fcount = await sql.query("SELECT count(*)::int AS n FROM posture_findings WHERE organization_id=$1", [orgs.Acme]);
    if (fcount.rows[0].n === 0) {
      const profile = (await sql.query('SELECT id FROM posture_profiles WHERE organization_id=$1', [orgs.Acme])).rows[0].id;
      for (const [title, domain, severity] of [
        ['12% of users without MFA', 'mfa', 'high'],
        ['Legacy auth protocols enabled', 'identity', 'critical'],
        ['3 devices non-compliant in Intune', 'device', 'moderate'],
        ['DMARC policy set to none', 'email', 'high'],
      ] as const) {
        await sql.query(
          `INSERT INTO posture_findings (organization_id, profile_id, title, domain, severity, risk_score, status, remediation_due_at)
           VALUES ($1,$2,$3,$4,$5,$6,'confirmed', now()+interval '30 days')`,
          [orgs.Acme, profile, title, domain, severity, severity === 'critical' ? 40 : severity === 'high' ? 25 : 12],
        );
      }
    }
  });
  logger.info('seed complete');
  process.exit(0);
}

run().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
