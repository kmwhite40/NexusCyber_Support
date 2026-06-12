// Seed the platform. Platform configuration (roles, permissions, tier groups, service
// catalog, ConMon checks, compliance controls, global KB, queues, automation samples) is
// ALWAYS seeded. Demo content — a single "Demo Corp" organization, demo agents/customers,
// the admin<->customer toggle account, demo tickets and posture — is seeded only when
// SEED_DEMO is not '0' (default on for local/demo; set SEED_DEMO=0 for a clean platform).
// Idempotent: safe to re-run. Uses the owner connection (bypasses RLS to bootstrap).
import { withSystemContext } from './pool.js';
import { logger } from '../logger.js';

const seedDemo = process.env.SEED_DEMO !== '0';

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
  ['oncall.acknowledge', 'oncall'],
  ['oncall.page', 'oncall'],
  ['oncall.manage', 'oncall'],
  ['automation.author', 'automation'],
  ['automation.publish', 'automation'],
  ['ticket.escalate', 'ticket'],
  ['audit.read', 'audit'],
  ['report.read.operational', 'reporting'],
  ['report.read.customer', 'reporting'],
  ['compliance.read', 'compliance'],
  ['compliance.manage', 'compliance'],
  ['kb.read', 'knowledge'],
  ['kb.author', 'knowledge'],
  ['kb.publish', 'knowledge'],
  ['change.create', 'change'],
  ['change.approve', 'change'],
  ['change.implement', 'change'],
  ['problem.manage', 'problem'],
  ['queue.manage', 'queue'],
  ['queue.read', 'queue'],
  ['service.read', 'cmdb'],
  ['service.manage', 'cmdb'],
  ['org.read', 'org'],
  ['org.manage', 'org'],
  ['notifications.read', 'notifications'],
  ['elevation.request', 'platform_admin'],
  ['elevation.approve', 'platform_admin'],
  ['elevation.break_glass', 'platform_admin'],
  ['admin.superuser', 'platform_admin'],
  ['alert.read', 'alerts'],
  ['alert.ack', 'alerts'],
  ['alert.manage', 'alerts'],
  ['channel.read', 'channels'],
  ['channel.manage', 'channels'],
  ['dashboard.read', 'dashboards'],
  ['dashboard.manage', 'dashboards'],
];

// ---- Roles -> permission keys ----
const ROLES: Record<string, { plane: 'nexus' | 'customer'; perms: string[] }> = {
  // Nexus plane
  Tier1: { plane: 'nexus', perms: ['ticket.create', 'ticket.read.all_assigned_customers', 'ticket.update', 'ticket.comment', 'kb.read', 'kb.author', 'queue.read', 'service.read', 'org.read', 'notifications.read', 'alert.read', 'alert.ack', 'dashboard.read'] },
  Tier2: {
    plane: 'nexus',
    perms: [
      'ticket.create', 'ticket.read.all_assigned_customers', 'ticket.update', 'ticket.comment',
      'ticket.assign', 'ticket.escalate', 'posture.read', 'report.read.operational',
      'oncall.acknowledge', 'oncall.page', 'elevation.request', 'kb.read', 'kb.author',
      'change.create', 'change.implement', 'problem.manage',
      'queue.read', 'service.read', 'org.read', 'notifications.read',
      'alert.read', 'alert.ack', 'dashboard.read',
    ],
  },
  SecurityAnalyst: {
    plane: 'nexus',
    perms: ['ticket.create', 'ticket.read.all_assigned_customers', 'ticket.escalate', 'posture.read', 'posture.write', 'posture.finding.manage', 'posture.request_exception', 'posture.approve_exception', 'oncall.acknowledge', 'oncall.page', 'audit.read', 'compliance.read', 'compliance.manage', 'elevation.request', 'elevation.break_glass', 'kb.read', 'kb.author', 'kb.publish', 'change.create', 'change.approve', 'problem.manage', 'queue.read', 'service.read', 'org.read', 'notifications.read', 'alert.read', 'alert.ack', 'dashboard.read'],
  },
  ServiceDeskManager: {
    plane: 'nexus',
    perms: ['ticket.create', 'ticket.read.all_assigned_customers', 'ticket.assign', 'ticket.update', 'ticket.comment', 'ticket.escalate', 'report.read.operational', 'customer.admin.manage_users', 'oncall.manage', 'oncall.acknowledge', 'oncall.page', 'automation.author', 'automation.publish', 'audit.read', 'posture.request_exception', 'posture.approve_exception', 'compliance.read', 'compliance.manage', 'elevation.request', 'elevation.approve', 'kb.read', 'kb.author', 'kb.publish', 'change.create', 'change.approve', 'change.implement', 'problem.manage', 'queue.manage', 'queue.read', 'service.read', 'service.manage', 'org.read', 'org.manage', 'notifications.read', 'alert.read', 'alert.ack', 'alert.manage', 'channel.read', 'channel.manage', 'dashboard.read', 'dashboard.manage'],
  },
  // Customer plane
  OrgAdmin: { plane: 'customer', perms: ['ticket.create', 'ticket.read.organization', 'ticket.comment', 'posture.read', 'posture.request_exception', 'customer.admin.manage_users', 'report.read.customer', 'audit.read', 'compliance.read', 'kb.read', 'kb.author', 'kb.publish'] },
  EndUser: { plane: 'customer', perms: ['ticket.create', 'ticket.read.own', 'ticket.comment.own', 'ticket.comment', 'kb.read'] },
  SecurityContact: { plane: 'customer', perms: ['ticket.read.organization', 'ticket.comment', 'posture.read', 'posture.request_exception', 'report.read.customer', 'compliance.read', 'kb.read'] },
};

async function run() {
  await withSystemContext(async (sql) => {
    // ===================== PLATFORM (always) =====================

    // Permissions
    for (const [key, domain] of PERMISSIONS) {
      await sql.query(`INSERT INTO permissions (key, domain) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [key, domain]);
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
        await sql.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roleId, perm]);
      }
    }

    // ---- Tier assignment groups (the Lite Helpdesk operating model) ----
    const tierGroups = [
      'Tier 1 — Helpdesk Analyst',
      'Tier 2 — M365 Administrator',
      'Tier 3 — Cloud Operations',
      'Security Operations',
      'Engagement Management',
    ];
    for (const name of tierGroups) {
      const found = await sql.query("SELECT 1 FROM assignment_groups WHERE name=$1 AND scope='nexus'", [name]);
      if (!found.rows[0]) {
        await sql.query("INSERT INTO assignment_groups (scope, name) VALUES ('nexus',$1)", [name]);
      }
    }

    // ---- Service catalog (request fulfillment workflows) ----
    const T1 = 'Tier 1 — Helpdesk Analyst';
    const T2 = 'Tier 2 — M365 Administrator';
    const T3 = 'Tier 3 — Cloud Operations';
    const SEC = 'Security Operations';
    const ENG = 'Engagement Management';
    const step = (key: string, label: string, role: string, automatable = false) => ({ key, label, role, automatable });

    const catalog = [
      {
        key: 'user.provisioning', name: 'New user creation & provisioning', category: 'Identity',
        ticket_type: 'access_request', owning_tier: T2, escalates_to: 'Engagement Management',
        requires_approval: true, approver_hint: 'Manager / Org Admin', default_priority: 'P3',
        security_class: 'privileged', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Tier 1: validate request & role/baseline', 'Tier1'),
          step('approval', 'Manager / Org Admin approval', 'OrgAdmin'),
          step('create_identity', 'Create identity in Entra ID', 'Tier2', true),
          step('baseline', 'Assign baseline groups + licenses', 'Tier2', true),
          step('enforce_ca', 'Enforce MFA + Conditional Access baseline', 'Tier2', true),
          step('verify', 'Verify access vs baseline', 'Tier2'),
          step('notify', 'Notify requester + new user', 'Tier2', true),
        ],
      },
      {
        key: 'user.offboarding', name: 'Deprovisioning & offboarding', category: 'Identity',
        ticket_type: 'access_request', owning_tier: T2, escalates_to: 'Security Operations',
        requires_approval: true, approver_hint: 'HR / Manager (+ SecOps if risky)', default_priority: 'P2',
        security_class: 'security', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Tier 1: verify authorization', 'Tier1'),
          step('approval', 'HR/Manager approval', 'OrgAdmin'),
          step('disable', 'Disable account + revoke sessions/tokens', 'Tier2', true),
          step('remove_groups', 'Remove group memberships + admin roles', 'Tier2', true),
          step('reclaim', 'Reclaim licenses', 'Tier2', true),
          step('legal_hold', 'Legal-hold check; preserve or convert mailbox', 'SecurityAnalyst'),
          step('evidence', 'Record revocation + reclamation evidence', 'Tier2'),
        ],
      },
      {
        key: 'account.password_reset', name: 'Password reset', category: 'Accounts',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: 'Security Operations',
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 15, sla_resolution_min: 60,
        steps: [
          step('verify_id', 'Verify requester identity (anti social-engineering)', 'Tier1'),
          step('reset', 'Reset password + force change at next sign-in', 'Tier1', true),
          step('notify', 'Notify via verified channel', 'Tier1', true),
        ],
      },
      {
        key: 'account.unlock', name: 'Account unlock', category: 'Accounts',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: 'Security Operations',
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 15, sla_resolution_min: 60,
        steps: [
          step('verify_id', 'Verify requester identity', 'Tier1'),
          step('unlock', 'Unlock account; check lockout cause', 'Tier1', true),
          step('notify', 'Notify requester', 'Tier1', true),
        ],
      },
      {
        key: 'group.membership_change', name: 'Group membership change', category: 'Identity',
        ticket_type: 'access_request', owning_tier: T1, escalates_to: 'Tier 2 — M365 Administrator',
        requires_approval: true, approver_hint: 'Group owner (privileged groups only)', default_priority: 'P3',
        security_class: 'privileged', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Tier 1: classify group (standard vs privileged)', 'Tier1'),
          step('approval', 'Owner/Org Admin approval (privileged only, SoD)', 'OrgAdmin'),
          step('modify', 'Modify membership in Entra ID', 'Tier1', true),
          step('verify', 'Verify least-privilege effective access', 'Tier1'),
        ],
      },
      {
        key: 'license.assignment', name: 'License assignment / reassignment', category: 'Licensing',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: 'Engagement Management',
        requires_approval: true, approver_hint: 'Cost owner (paid SKUs only)', default_priority: 'P4',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 240,
        steps: [
          step('check', 'Check SKU availability', 'Tier1', true),
          step('approval', 'Cost-owner approval (paid SKUs)', 'OrgAdmin'),
          step('reclaim', 'Reclaim from prior user (reassignment)', 'Tier1', true),
          step('assign', 'Assign / verify license active', 'Tier1', true),
        ],
      },
      {
        key: 'support.remote_session', name: 'Remote support (business hours)', category: 'Support',
        ticket_type: 'incident', owning_tier: T1, escalates_to: 'Tier 2 — M365 Administrator',
        requires_approval: false, approver_hint: 'End-user consent required', default_priority: 'P3',
        security_class: 'standard', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('consent', 'Obtain end-user consent for remote session', 'Tier1'),
          step('session', 'Establish session via approved tool', 'Tier1'),
          step('resolve', 'Troubleshoot / resolve (reassign to Tier 2 if M365)', 'Tier1'),
          step('evidence', 'Session log/recording -> evidence', 'Tier1'),
        ],
      },

      // ---- Microsoft 365 (GCC / GCC High) ----
      {
        key: 'm365.shared_mailbox', name: 'Shared mailbox & distribution list provisioning', category: 'Microsoft 365',
        ticket_type: 'service_request', owning_tier: T2, escalates_to: SEC,
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Tier 1: validate request, owner & naming standard', 'Tier1'),
          step('create', 'Create shared mailbox / DL in Exchange Online (GCC)', 'Tier2', true),
          step('delegate', 'Assign send-as / full-access delegates (least privilege)', 'Tier2', true),
          step('verify', 'Verify mail flow + delegate access', 'Tier2'),
          step('notify', 'Notify requester', 'Tier2', true),
        ],
      },
      {
        key: 'm365.guest_access', name: 'External (B2B) guest access', category: 'Microsoft 365',
        ticket_type: 'access_request', owning_tier: T2, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Sponsor + Security Operations', default_priority: 'P2',
        security_class: 'security', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Tier 1: validate sponsor & business need', 'Tier1'),
          step('approval', 'SecOps + sponsor approval (external sharing in gov tenant)', 'SecurityAnalyst'),
          step('configure', 'Create B2B guest; scope entitlement + Conditional Access', 'Tier2', true),
          step('timebound', 'Set access review / expiration (time-bound)', 'Tier2', true),
          step('verify', 'Verify least-privilege guest access', 'Tier2'),
        ],
      },
      {
        key: 'm365.purview_dlp_exception', name: 'Purview DLP / sensitivity-label exception', category: 'Microsoft 365',
        ticket_type: 'service_request', owning_tier: SEC, escalates_to: ENG,
        requires_approval: true, approver_hint: 'Data owner + Security Operations', default_priority: 'P2',
        security_class: 'security', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Classify data + policy impacted (CUI/ITAR check)', 'SecurityAnalyst'),
          step('approval', 'Data owner + SecOps approval (SoD)', 'OrgAdmin'),
          step('scope', 'Scope exception (user / site / time-bound)', 'SecurityAnalyst', true),
          step('implement', 'Apply Purview policy exception', 'Tier2', true),
          step('evidence', 'Record exception + compensating control', 'SecurityAnalyst'),
        ],
      },

      // ---- Azure Government ----
      {
        key: 'azure.pim_role', name: 'Azure RBAC / PIM eligible role assignment', category: 'Azure Government',
        ticket_type: 'access_request', owning_tier: T3, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Resource owner + Security Operations', default_priority: 'P2',
        security_class: 'privileged', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Validate role + scope (least privilege)', 'Tier3'),
          step('approval', 'Resource owner + SecOps approval', 'OrgAdmin'),
          step('configure', 'Make eligible in PIM; require MFA + justification', 'Tier3', true),
          step('timebound', 'Set activation window + max duration', 'Tier3', true),
          step('verify', 'Verify eligible (not standing) assignment', 'Tier3'),
        ],
      },
      {
        key: 'azure.landing_zone', name: 'Azure Gov landing-zone / resource provisioning', category: 'Azure Government',
        ticket_type: 'service_request', owning_tier: T3, escalates_to: ENG,
        requires_approval: true, approver_hint: 'Cloud governance board', default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 1440,
        steps: [
          step('triage', 'Validate subscription / management group + naming & tags', 'Tier3'),
          step('approval', 'Cloud governance approval', 'OrgAdmin'),
          step('provision', 'Deploy via IaC (policy + security baseline)', 'Tier3', true),
          step('policy', 'Confirm Azure Policy / guardrails applied', 'Tier3', true),
          step('verify', 'Verify compliance + cost tags', 'Tier3'),
        ],
      },
      {
        key: 'azure.keyvault_access', name: 'Key Vault access policy change', category: 'Azure Government',
        ticket_type: 'access_request', owning_tier: T3, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Vault owner + Security Operations', default_priority: 'P2',
        security_class: 'security', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Validate secret/key + requester need', 'Tier3'),
          step('approval', 'Vault owner + SecOps approval', 'SecurityAnalyst'),
          step('grant', 'Grant access policy / RBAC (least privilege)', 'Tier3', true),
          step('timebound', 'Time-bound access + enable logging', 'Tier3', true),
          step('verify', 'Verify scoped access', 'Tier3'),
        ],
      },

      // ---- AWS GovCloud (US) ----
      {
        key: 'aws.identity_center', name: 'AWS IAM Identity Center permission-set assignment', category: 'AWS GovCloud',
        ticket_type: 'access_request', owning_tier: T3, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Account owner + Security Operations', default_priority: 'P2',
        security_class: 'privileged', sla_response_min: 30, sla_resolution_min: 240,
        steps: [
          step('triage', 'Validate permission set + account scope', 'Tier3'),
          step('approval', 'Account owner + SecOps approval', 'OrgAdmin'),
          step('assign', 'Assign permission set in IAM Identity Center', 'Tier3', true),
          step('guardrail', 'Confirm SCP guardrails + session duration', 'Tier3', true),
          step('verify', 'Verify least-privilege effective access', 'Tier3'),
        ],
      },
      {
        key: 'aws.account_provisioning', name: 'AWS GovCloud account / OU provisioning', category: 'AWS GovCloud',
        ticket_type: 'service_request', owning_tier: T3, escalates_to: ENG,
        requires_approval: true, approver_hint: 'Cloud governance board', default_priority: 'P3',
        security_class: 'standard', sla_response_min: 120, sla_resolution_min: 2880,
        steps: [
          step('triage', 'Validate OU placement + naming', 'Tier3'),
          step('approval', 'Cloud governance approval', 'OrgAdmin'),
          step('provision', 'Provision account via Control Tower (GovCloud)', 'Tier3', true),
          step('baseline', 'Apply SCPs, CloudTrail, Config, GuardDuty baseline', 'Tier3', true),
          step('verify', 'Verify baseline + billing / tags', 'Tier3'),
        ],
      },
      {
        key: 'aws.s3_secure_bucket', name: 'AWS S3 bucket provisioning (gov baseline)', category: 'AWS GovCloud',
        ticket_type: 'service_request', owning_tier: T3, escalates_to: SEC,
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Validate data classification + naming', 'Tier3'),
          step('provision', 'Create bucket: SSE-KMS, Block Public Access, versioning', 'Tier3', true),
          step('policy', 'Apply least-privilege bucket policy + TLS-only', 'Tier3', true),
          step('verify', 'Verify encryption + public-access lockdown', 'Tier3'),
        ],
      },

      // ---- Devices & Endpoints ----
      {
        key: 'device.enrollment', name: 'Device enrollment (Intune)', category: 'Devices & Endpoints',
        ticket_type: 'service_request', owning_tier: T2, escalates_to: SEC,
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Verify device ownership + platform (Windows/macOS/iOS/Android)', 'Tier1'),
          step('enroll', 'Enroll device in Intune; assign compliance + config profiles', 'Tier2', true),
          step('verify', 'Confirm compliant + apps deployed', 'Tier2'),
          step('notify', 'Notify user with first-run steps', 'Tier2', true),
        ],
      },
      {
        key: 'device.lost_stolen', name: 'Lost / stolen device — wipe & revoke', category: 'Devices & Endpoints',
        ticket_type: 'incident', owning_tier: SEC, escalates_to: ENG,
        requires_approval: false, approver_hint: 'Security Operations (immediate)', default_priority: 'P1',
        security_class: 'security', sla_response_min: 15, sla_resolution_min: 120,
        steps: [
          step('contain', 'Revoke sessions/tokens + disable sign-in', 'SecurityAnalyst', true),
          step('wipe', 'Issue remote wipe (or selective wipe for BYOD) via Intune', 'Tier2', true),
          step('rotate', 'Rotate any cached credentials / re-enroll MFA', 'Tier2', true),
          step('evidence', 'Record device id, action, and timeline', 'SecurityAnalyst'),
        ],
      },
      {
        key: 'device.bitlocker_recovery', name: 'BitLocker recovery key retrieval', category: 'Devices & Endpoints',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: T2,
        requires_approval: false, approver_hint: null, default_priority: 'P2',
        security_class: 'standard', sla_response_min: 15, sla_resolution_min: 60,
        steps: [
          step('verify_id', 'Verify requester identity + device ownership', 'Tier1'),
          step('retrieve', 'Retrieve recovery key from Entra/Intune', 'Tier1', true),
          step('notify', 'Provide key via verified channel; advise re-save', 'Tier1', true),
        ],
      },
      {
        key: 'software.install', name: 'Software installation request', category: 'Devices & Endpoints',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: T2,
        requires_approval: true, approver_hint: 'Manager (licensed/paid software)', default_priority: 'P4',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Validate software is approved + license available', 'Tier1'),
          step('approval', 'Manager approval (paid/licensed titles)', 'OrgAdmin'),
          step('deploy', 'Deploy via Company Portal / Intune', 'Tier2', true),
          step('verify', 'Confirm install + license assignment', 'Tier1'),
        ],
      },

      // ---- Networking ----
      {
        key: 'network.vpn_access', name: 'VPN access request', category: 'Networking',
        ticket_type: 'access_request', owning_tier: T2, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Manager + Security Operations', default_priority: 'P3',
        security_class: 'security', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Validate business need + device compliance', 'Tier1'),
          step('approval', 'Manager + SecOps approval', 'OrgAdmin'),
          step('grant', 'Add to VPN group; enforce MFA + posture check', 'Tier2', true),
          step('verify', 'Confirm connectivity from a compliant device', 'Tier2'),
        ],
      },
      {
        key: 'network.firewall_change', name: 'Firewall / network rule change', category: 'Networking',
        ticket_type: 'change', owning_tier: T3, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Network owner + Security Operations (CAB)', default_priority: 'P2',
        security_class: 'security', sla_response_min: 30, sla_resolution_min: 1440,
        steps: [
          step('triage', 'Document source/dest/port + justification', 'Tier3'),
          step('approval', 'CAB: network owner + SecOps approval', 'SecurityAnalyst'),
          step('implement', 'Apply rule via IaC; least-privilege + logging', 'Tier3', true),
          step('verify', 'Verify flow + no broad exposure; record backout', 'Tier3'),
        ],
      },

      // ---- Security ----
      {
        key: 'security.phishing_report', name: 'Report suspected phishing', category: 'Security',
        ticket_type: 'incident', owning_tier: SEC, escalates_to: ENG,
        requires_approval: false, approver_hint: null, default_priority: 'P2',
        security_class: 'security', sla_response_min: 15, sla_resolution_min: 240,
        steps: [
          step('triage', 'Analyze headers/URLs/attachments (detonate if needed)', 'SecurityAnalyst'),
          step('contain', 'Purge from mailboxes; block sender/URL', 'SecurityAnalyst', true),
          step('hunt', 'Hunt for other recipients + clicks', 'SecurityAnalyst', true),
          step('notify', 'Notify reporter + affected users', 'SecurityAnalyst'),
        ],
      },
      {
        key: 'security.access_review', name: 'Periodic access review (attestation)', category: 'Security',
        ticket_type: 'service_request', owning_tier: SEC, escalates_to: ENG,
        requires_approval: true, approver_hint: 'Resource owner', default_priority: 'P3',
        security_class: 'security', sla_response_min: 120, sla_resolution_min: 2880,
        steps: [
          step('scope', 'Generate access list for the resource/role', 'SecurityAnalyst', true),
          step('attest', 'Owner attests / flags removals', 'OrgAdmin'),
          step('remediate', 'Remove flagged access; record decisions', 'Tier2', true),
          step('evidence', 'Store attestation evidence for the control', 'SecurityAnalyst'),
        ],
      },
      {
        key: 'security.certificate_request', name: 'TLS / code-signing certificate request', category: 'Security',
        ticket_type: 'service_request', owning_tier: T3, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Security Operations', default_priority: 'P3',
        security_class: 'security', sla_response_min: 60, sla_resolution_min: 1440,
        steps: [
          step('triage', 'Validate CN/SAN, key type, and usage', 'Tier3'),
          step('approval', 'SecOps approval (issuance policy)', 'SecurityAnalyst'),
          step('issue', 'Issue from CA; store key in Key Vault/HSM', 'Tier3', true),
          step('verify', 'Install + verify chain; set renewal reminder', 'Tier3', true),
        ],
      },

      // ---- Data & Backup ----
      {
        key: 'data.file_restore', name: 'File / folder restore from backup', category: 'Data & Backup',
        ticket_type: 'service_request', owning_tier: T2, escalates_to: T3,
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Identify path, version, and point-in-time', 'Tier1'),
          step('restore', 'Restore from backup/recycle bin/versioning', 'Tier2', true),
          step('verify', 'Confirm integrity + permissions with requester', 'Tier2'),
        ],
      },
      {
        key: 'data.mailbox_restore', name: 'Mailbox / item recovery', category: 'Data & Backup',
        ticket_type: 'service_request', owning_tier: T2, escalates_to: SEC,
        requires_approval: false, approver_hint: 'Legal-hold check for litigation', default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Scope items + window; check legal hold', 'Tier2'),
          step('recover', 'Recover from Recoverable Items / soft-deleted mailbox', 'Tier2', true),
          step('verify', 'Confirm recovery with requester', 'Tier2'),
        ],
      },

      // ---- Collaboration ----
      {
        key: 'collab.teams_site', name: 'New Team / SharePoint site', category: 'Collaboration',
        ticket_type: 'service_request', owning_tier: T2, escalates_to: SEC,
        requires_approval: true, approver_hint: 'Sponsor (data classification)', default_priority: 'P3',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Validate name, owners, and data classification', 'Tier1'),
          step('approval', 'Sponsor approval (classification + external sharing)', 'OrgAdmin'),
          step('provision', 'Create Team/site from approved template + labels', 'Tier2', true),
          step('verify', 'Confirm membership, sharing scope, and labels', 'Tier2'),
        ],
      },

      // ---- Telephony ----
      {
        key: 'telephony.teams_phone', name: 'Teams Phone / calling plan', category: 'Telephony',
        ticket_type: 'service_request', owning_tier: T2, escalates_to: ENG,
        requires_approval: true, approver_hint: 'Cost owner (calling plan)', default_priority: 'P4',
        security_class: 'standard', sla_response_min: 120, sla_resolution_min: 1440,
        steps: [
          step('triage', 'Validate license + number/locale needs', 'Tier1'),
          step('approval', 'Cost-owner approval (paid plan)', 'OrgAdmin'),
          step('assign', 'Assign license, number, and voice policy', 'Tier2', true),
          step('verify', 'Test inbound/outbound + emergency address', 'Tier2'),
        ],
      },

      // ---- Government (GCC High / regulated) ----
      {
        key: 'gov.cui_workspace', name: 'CUI workspace provisioning', category: 'Government',
        ticket_type: 'access_request', owning_tier: SEC, escalates_to: ENG,
        requires_approval: true, approver_hint: 'ISSO + data owner', default_priority: 'P2',
        security_class: 'security', sla_response_min: 60, sla_resolution_min: 2880,
        steps: [
          step('triage', 'Validate CUI category + handling requirements', 'SecurityAnalyst'),
          step('approval', 'ISSO + data owner approval', 'OrgAdmin'),
          step('provision', 'Create labeled workspace; restrict sharing/export', 'Tier2', true),
          step('enforce', 'Apply DLP + Conditional Access + audit', 'SecurityAnalyst', true),
          step('evidence', 'Record authorization + control mapping', 'SecurityAnalyst'),
        ],
      },

      // ---- Software & Hardware (common IT requests) ----
      {
        key: 'software.new_request', name: 'Request new software', category: 'Software',
        description: 'If you need a software license, raise a request here.',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: T2,
        requires_approval: true, approver_hint: 'Manager / cost owner (paid licenses)', default_priority: 'P4',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Validate software, license type, and availability', 'Tier1'),
          step('approval', 'Manager / cost-owner approval (paid licenses)', 'OrgAdmin'),
          step('assign', 'Assign or procure license', 'Tier1', true),
          step('deploy', 'Deploy via Company Portal / Intune', 'Tier2', true),
          step('verify', 'Confirm install + license active', 'Tier1'),
        ],
      },
      {
        key: 'hardware.report_broken', name: 'Report broken hardware', category: 'Hardware',
        description: 'Report hardware that might be faulty or broken e.g. a broken computer screen or a damaged server.',
        ticket_type: 'incident', owning_tier: T1, escalates_to: ENG,
        requires_approval: false, approver_hint: null, default_priority: 'P3',
        security_class: 'standard', sla_response_min: 30, sla_resolution_min: 480,
        steps: [
          step('triage', 'Capture device, fault symptoms, and impact', 'Tier1'),
          step('diagnose', 'Diagnose remotely / confirm hardware fault', 'Tier1'),
          step('repair', 'Repair or arrange replacement / RMA', 'Tier2'),
          step('verify', 'Verify fix with user; update asset record', 'Tier1'),
        ],
      },
      {
        key: 'hardware.request_new', name: 'Request new hardware', category: 'Hardware',
        description: 'For example, a new mouse or monitor.',
        ticket_type: 'service_request', owning_tier: T1, escalates_to: ENG,
        requires_approval: true, approver_hint: 'Manager / cost owner', default_priority: 'P4',
        security_class: 'standard', sla_response_min: 60, sla_resolution_min: 480,
        steps: [
          step('triage', 'Validate item, justification, and budget', 'Tier1'),
          step('approval', 'Manager / cost-owner approval', 'OrgAdmin'),
          step('order', 'Order or allocate from stock', 'Tier1', true),
          step('deliver', 'Deliver / ship and confirm receipt', 'Tier1'),
        ],
      },
    ];

    for (const item of catalog) {
      await sql.query(
        `INSERT INTO service_catalog_items
           (key,name,category,description,ticket_type,owning_tier,escalates_to,requires_approval,
            approver_hint,default_priority,security_class,sla_response_min,sla_resolution_min,fulfillment_steps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, category=EXCLUDED.category, description=EXCLUDED.description,
           owning_tier=EXCLUDED.owning_tier, escalates_to=EXCLUDED.escalates_to,
           requires_approval=EXCLUDED.requires_approval, fulfillment_steps=EXCLUDED.fulfillment_steps,
           sla_response_min=EXCLUDED.sla_response_min, sla_resolution_min=EXCLUDED.sla_resolution_min`,
        [
          item.key, item.name, item.category, (item as { description?: string }).description ?? item.name, item.ticket_type, item.owning_tier,
          item.escalates_to, item.requires_approval, item.approver_hint, item.default_priority,
          item.security_class, item.sla_response_min, item.sla_resolution_min, JSON.stringify(item.steps),
        ],
      );
    }

    // ---- ConMon checks ----
    const conmonChecks = [
      ['mfa_coverage', 'MFA coverage ≥ threshold', 'identity', 1, ['IA-2'], 'high'],
      ['ca_baseline', 'Conditional Access baseline present', 'identity', 1, ['AC-2', 'AC-3'], 'high'],
      ['priv_review', 'Privileged / standing-admin review', 'privileged', 7, ['AC-6', 'AC-2'], 'high'],
      ['vuln_scan', 'Vulnerability scan (criticals)', 'vuln', 7, ['RA-5', 'SI-2'], 'critical'],
      ['patch_compliance', 'Patch compliance ≥ threshold', 'patch', 7, ['SI-2'], 'high'],
      ['device_compliance', 'Device compliance (Intune)', 'device', 7, ['CM-6'], 'moderate'],
      ['email_security', 'Email security (SPF/DKIM/DMARC)', 'email', 7, ['SC-8', 'SI-8'], 'high'],
      ['backup_success', 'Backup success', 'backup', 1, ['CP-9'], 'high'],
      ['audit_review', 'Audit-log review / SIEM health', 'audit', 1, ['AU-6', 'AU-12'], 'moderate'],
      ['poam_aging', 'POA&M aging / expiring exceptions', 'compliance', 7, ['CA-5'], 'moderate'],
    ] as const;
    for (const [key, name, domain, cadence, refs, severity] of conmonChecks) {
      await sql.query(
        `INSERT INTO conmon_checks (key,name,domain,cadence_days,control_refs,severity)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
        [key, name, domain, cadence, refs as unknown as string[], severity],
      );
    }

    // ---- Compliance control catalog (starter NIST 800-53 subset) + evidence mappings ----
    const controls = [
      ['AC-2', 'NIST-800-53', 'Access Control', 'Account Management'],
      ['AC-6', 'NIST-800-53', 'Access Control', 'Least Privilege'],
      ['AU-6', 'NIST-800-53', 'Audit and Accountability', 'Audit Review, Analysis, and Reporting'],
      ['AU-12', 'NIST-800-53', 'Audit and Accountability', 'Audit Record Generation'],
      ['IA-2', 'NIST-800-53', 'Identification and Authentication', 'Identification and Authentication (Users)'],
      ['RA-5', 'NIST-800-53', 'Risk Assessment', 'Vulnerability Monitoring and Scanning'],
      ['SI-2', 'NIST-800-53', 'System and Information Integrity', 'Flaw Remediation'],
      ['SC-8', 'NIST-800-53', 'System and Communications Protection', 'Transmission Confidentiality and Integrity'],
      ['CP-9', 'NIST-800-53', 'Contingency Planning', 'System Backup'],
      ['CA-5', 'NIST-800-53', 'Assessment, Authorization, and Monitoring', 'Plan of Action and Milestones'],
    ] as const;
    for (const [id, framework, family, title] of controls) {
      await sql.query(
        `INSERT INTO compliance_controls (control_id, framework, family, title)
         VALUES ($1,$2,$3,$4) ON CONFLICT (control_id) DO NOTHING`,
        [id, framework, family, title],
      );
    }
    const mappings: Array<[string, 'audit_action' | 'posture_domain' | 'conmon_check', string]> = [
      ['IA-2', 'conmon_check', 'mfa_coverage'],
      ['AC-2', 'conmon_check', 'ca_baseline'],
      ['AC-6', 'conmon_check', 'priv_review'],
      ['RA-5', 'conmon_check', 'vuln_scan'],
      ['SI-2', 'conmon_check', 'patch_compliance'],
      ['SC-8', 'conmon_check', 'email_security'],
      ['CP-9', 'conmon_check', 'backup_success'],
      ['AU-6', 'conmon_check', 'audit_review'],
      ['CA-5', 'conmon_check', 'poam_aging'],
      ['AU-12', 'audit_action', 'posture.finding.create'],
      ['AC-2', 'audit_action', 'service_request.create'],
      ['IA-2', 'posture_domain', 'mfa'],
    ];
    for (const [controlId, source, sourceKey] of mappings) {
      await sql.query(
        `INSERT INTO control_mappings (control_id, source, source_key)
         VALUES ($1,$2,$3) ON CONFLICT (control_id, source, source_key) DO NOTHING`,
        [controlId, source, sourceKey],
      );
    }

    // ===================== DEMO identities (gated) =====================
    let demoOrgId: string | null = null;
    let demoCustomerId: string | null = null;
    const agentIds: string[] = [];

    // Upsert a user and assign a role. Nexus agents are scoped to the demo org; customers to
    // their own org. Returns the user id.
    async function upsertUser(plane: 'nexus' | 'customer', email: string, displayName: string, orgId: string | null, roleKey: string) {
      const { rows } = await sql.query(
        `INSERT INTO users (plane, organization_id, email, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (plane, email) DO UPDATE SET display_name=EXCLUDED.display_name, organization_id=EXCLUDED.organization_id
         RETURNING id`,
        [plane, orgId, email, displayName],
      );
      const userId = rows[0].id;
      const assignOrg = plane === 'nexus' ? demoOrgId : orgId;
      if (assignOrg) {
        await sql.query(
          `INSERT INTO role_assignments (user_id, role_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [userId, roleIds[roleKey], assignOrg],
        );
      }
      return userId;
    }

    if (seedDemo) {
      // Demo Corp: the single demonstration organization.
      const demoOrg = await sql.query("SELECT id FROM organizations WHERE name='Demo Corp'");
      if (demoOrg.rows[0]) {
        demoOrgId = demoOrg.rows[0].id;
      } else {
        demoOrgId = (
          await sql.query(`INSERT INTO organizations (name, cloud, enclave_id, status) VALUES ('Demo Corp','commercial','commercial','active') RETURNING id`)
        ).rows[0].id;
      }
      await sql.query(
        `INSERT INTO organization_domains (organization_id, domain, verified_at, verification_method)
         VALUES ($1,'demo.example.com', now(),'seed') ON CONFLICT (domain) DO NOTHING`,
        [demoOrgId],
      );
      const hasProfile = await sql.query('SELECT 1 FROM posture_profiles WHERE organization_id=$1', [demoOrgId]);
      if (!hasProfile.rows[0]) {
        await sql.query(`INSERT INTO posture_profiles (organization_id, scope_type) VALUES ($1,'org')`, [demoOrgId]);
      }

      // Default dashboard per org (authoritative seed; migration 0025's INSERT is a no-op on a
      // fresh bootstrap because orgs don't exist yet at migration time).
      await sql.query(
        `INSERT INTO dashboards (organization_id, owner_user_id, name, layout, is_default)
         SELECT o.id, NULL, 'Operations overview',
           '[{"type":"kpis"},{"type":"ticket_volume"},{"type":"posture_gauge"},{"type":"top_findings"}]'::jsonb, true
         FROM organizations o
         WHERE NOT EXISTS (SELECT 1 FROM dashboards d WHERE d.organization_id = o.id AND d.is_default)`,
      );

      // Nexus operators (no password -> dev login).
      await upsertUser('nexus', 'agent@nexus.example.com', 'Avery Agent (Tier 2)', null, 'Tier2');
      await upsertUser('nexus', 'manager@nexus.example.com', 'Morgan Manager', null, 'ServiceDeskManager');
      await upsertUser('nexus', 'analyst@nexus.example.com', 'Sam Analyst (Security)', null, 'SecurityAnalyst');

      // A pool of desk agents so the analytics agent-leaderboards have data.
      const agentNames = [
        'Mata Lucero', 'Aldo Carrillo', 'Galindo Guadalupe', 'Ramon Macias', 'Alfonso Barraza',
        'Aurelio Tanori', 'Diana Rojo', 'Isela Leyva', 'Segura Garcia', 'Yomara Aqudelo',
      ];
      for (let i = 0; i < agentNames.length; i++) {
        const id = await upsertUser('nexus', `desk${i + 1}@nexus.example.com`, agentNames[i], null, i % 2 === 0 ? 'Tier1' : 'Tier2');
        agentIds.push(id);
      }

      // Demo customer users in Demo Corp.
      demoCustomerId = await upsertUser('customer', 'user@demo.example.com', 'Alex User', demoOrgId, 'EndUser');
      await upsertUser('customer', 'security@demo.example.com', 'Riley Security', demoOrgId, 'SecurityContact');

      // ---- The demo toggle account: one demo identity that flips admin <-> customer ----
      // Admin view: a Nexus ServiceDeskManager scoped to Demo Corp.
      const demoAdminId = await upsertUser('nexus', 'demo-admin@anchor.example', 'Demo — Admin view', null, 'ServiceDeskManager');
      // Customer view: an Org Admin in Demo Corp.
      const demoCustViewId = await upsertUser('customer', 'demo-customer@demo.example', 'Demo — Customer view', demoOrgId, 'OrgAdmin');
      await sql.query('UPDATE users SET is_demo=true, demo_pair_user_id=$2 WHERE id=$1', [demoAdminId, demoCustViewId]);
      await sql.query('UPDATE users SET is_demo=true, demo_pair_user_id=$2 WHERE id=$1', [demoCustViewId, demoAdminId]);
    }

    // ---- Example automation rules (global, published) ----
    const automationRules = [
      {
        name: 'Tag & note P1 incidents',
        definition: {
          trigger: { event: 'ticket.created' },
          conditions: { all: [{ field: 'priority', op: 'eq', value: 'P1' }, { field: 'type', op: 'eq', value: 'incident' }] },
          actions: [
            { type: 'add_tag', tag: 'urgent' },
            { type: 'add_internal_note', text: 'Auto: P1 incident created — confirm on-call coverage.' },
          ],
        },
      },
      {
        name: 'Note on SLA breach',
        definition: {
          trigger: { event: 'sla.breached' },
          conditions: { all: [{ field: 'metric', op: 'eq', value: 'resolution' }] },
          actions: [{ type: 'add_internal_note', text: 'Auto: resolution SLA breached — manager review required.' }],
        },
      },
    ];
    const rulesExist = await sql.query('SELECT count(*)::int AS n FROM automation_rules');
    if (rulesExist.rows[0].n === 0) {
      const author = (await sql.query("SELECT id FROM users WHERE email='analyst@nexus.example.com'")).rows[0]?.id;
      const publisher = (await sql.query("SELECT id FROM users WHERE email='manager@nexus.example.com'")).rows[0]?.id;
      for (const r of automationRules) {
        await sql.query(
          `INSERT INTO automation_rules (name, definition, state, author_id, publisher_id) VALUES ($1,$2,'published',$3,$4)`,
          [r.name, JSON.stringify(r.definition), author ?? null, publisher ?? null],
        );
      }
    }

    // ---- Knowledge base: global spaces + published articles (Confluence-style) ----
    // Idempotent per space/page so the library can be extended and re-seeded safely.
    const kbAuthor = (await sql.query("SELECT id FROM users WHERE email='analyst@nexus.example.com'")).rows[0]?.id ?? null;

    const kbSpaces: Array<[string, string, string]> = [
      ['SD', 'Service Desk', 'Self-service knowledge for common requests and incidents'],
      ['SEC', 'Security', 'Staying secure: MFA, phishing, lost devices, and incident response'],
      ['M365', 'Microsoft 365', 'Teams, Outlook, SharePoint/OneDrive, and information protection'],
      ['CLOUD', 'Cloud Operations', 'Azure Government, AWS GovCloud, access, and landing-zone standards'],
      ['POL', 'Policies & Compliance', 'Policies, data handling, and continuous-monitoring overviews'],
    ];
    const kbSpaceIds: Record<string, string> = {};
    for (const [key, name, description] of kbSpaces) {
      const found = await sql.query('SELECT id FROM kb_spaces WHERE organization_id IS NULL AND key=$1', [key]);
      kbSpaceIds[key] = found.rows[0]
        ? found.rows[0].id
        : (
            await sql.query(
              `INSERT INTO kb_spaces (organization_id, key, name, description, created_by) VALUES (NULL,$1,$2,$3,$4) RETURNING id`,
              [key, name, description, kbAuthor],
            )
          ).rows[0].id;
    }

    interface KbPage { space: string; title: string; body: string; labels: string[]; parent?: string }
    const kbPages: KbPage[] = [
      // ----- Service Desk -----
      { space: 'SD', title: 'Reset your password', labels: ['password', 'accounts', 'self-service'],
        body: '# Reset your password\n\nIf you are locked out, use the self-service reset:\n\n1. Go to the sign-in page and choose **Forgot password**.\n2. Verify your identity with MFA.\n3. Set a new password meeting the complexity policy.\n\nStill stuck? Submit a **Password reset** request from the Service catalog.' },
      { space: 'SD', title: 'Unlock your account', labels: ['accounts', 'self-service'],
        body: '# Account locked out\n\nToo many failed sign-ins can lock your account temporarily.\n\n1. Wait 15 minutes and try again from a trusted device.\n2. If you recently changed your password, update it in every app (mail, VPN, Wi-Fi).\n3. Still locked? Submit an **Account unlock** request and we will verify your identity and clear the lockout.' },
      { space: 'SD', title: 'Set up email & calendar on your phone', labels: ['email', 'mobile', 'outlook'],
        body: '# Email on mobile\n\nUse the **Outlook** app (required for compliance — it keeps work data in a protected container).\n\n1. Install **Microsoft Outlook** from your app store.\n2. Add your work account and approve the MFA prompt.\n3. If asked, enroll the device or accept the app-protection policy.\n\nNative mail apps are not supported for work mail.' },
      { space: 'SD', title: 'Request a new laptop or hardware', labels: ['hardware', 'requests'],
        body: '# Request hardware\n\nOpen a request describing the hardware needed, your manager, and the cost center, or use the Service catalog **Software installation** / provisioning items. Standard laptops ship within 5 business days after approval.' },
      { space: 'SD', title: 'VPN troubleshooting', labels: ['vpn', 'network', 'troubleshooting'],
        body: '# VPN keeps disconnecting\n\nTry these steps before opening a ticket:\n\n1. Update the VPN client to the latest version.\n2. Switch networks (wired vs Wi-Fi) to isolate the issue.\n3. Confirm your device is compliant in the device portal.\n\nIf drops persist, open an incident and attach the client logs.' },
      { space: 'SD', title: 'Printing & file shares', labels: ['printing', 'files'],
        body: '# Printing & file shares\n\n**Printers:** install from the self-service portal; choose the printer nearest you by location code.\n\n**File shares / SharePoint:** access is granted by group. If you cannot reach a share, request access via **Group membership change** and name the share + your manager.' },
      { space: 'SD', title: 'How to submit a great ticket', labels: ['tickets', 'how-to'],
        body: '# Help us help you\n\nA good ticket is resolved faster. Include:\n\n- **What** happened and the exact error text or a screenshot.\n- **When** it started and whether it is constant or intermittent.\n- **Who** is affected (just you, your team, everyone?).\n- **Impact** — can you work, or are you blocked?\n\nWe set priority from **impact × urgency** — see the child article on priorities & SLAs.' },
      { space: 'SD', title: 'Ticket priorities & SLAs explained', labels: ['sla', 'priority'], parent: 'How to submit a great ticket',
        body: '# Priorities & SLAs\n\nPriority is derived from **impact** (how many people / how critical) and **urgency** (how time-sensitive):\n\n- **P1** — major outage or security incident. Response in minutes, resolution targeted in hours.\n- **P2** — significant degradation or a blocked individual. Same business day.\n- **P3** — standard request or single-user issue. 1–3 business days.\n- **P4** — low-impact / scheduled. As capacity allows.\n\nSLA clocks pause while a ticket is waiting on you and resume when work continues.' },

      // ----- Security -----
      { space: 'SEC', title: 'Set up multi-factor authentication (MFA)', labels: ['mfa', 'identity', 'security'],
        body: '# Set up MFA\n\nMFA protects your account even if your password is stolen.\n\n1. Open the **My Sign-ins** page.\n2. Add the **Authenticator app** method (preferred over SMS).\n3. Approve the test prompt.\n\nMFA is required for all accounts under the Conditional Access baseline.' },
      { space: 'SEC', title: 'Report a phishing email', labels: ['phishing', 'email', 'security'],
        body: '# Spotted a suspicious email?\n\n**Do not click links or open attachments.**\n\n1. Use the **Report Phishing** button in Outlook (or forward to the security mailbox).\n2. Delete the message after reporting.\n3. If you already clicked or entered credentials, change your password immediately and open a **Report suspected phishing** incident.\n\nWe analyze, purge it from other mailboxes, and block the sender.' },
      { space: 'SEC', title: 'Lost or stolen device', labels: ['device', 'incident', 'security'],
        body: '# Lost or stolen device\n\nAct fast to protect data.\n\n1. Open a **Lost / stolen device — wipe & revoke** request immediately (P1).\n2. We revoke sessions, disable sign-in, and remote-wipe the device.\n3. Re-enroll MFA and change your password from a trusted device.\n\nReport even if you think it may turn up — we can reverse a selective wipe more easily than a breach.' },
      { space: 'SEC', title: 'Just-in-time elevation & break-glass', labels: ['privileged', 'jit', 'security'],
        body: '# Privileged access is time-boxed\n\nStanding admin rights are minimized. To perform privileged work:\n\n1. **Request elevation** for the specific permissions and reason.\n2. A different approver grants it (separation of duties); it expires automatically.\n3. **Break-glass** exists for emergencies — it is immediate but loud: it pages on-call and raises a critical audit event that is reviewed.' },
      { space: 'SEC', title: 'Handling Controlled Unclassified Information (CUI)', labels: ['cui', 'compliance', 'security'],
        body: '# CUI handling basics\n\n- Store CUI only in **approved, labeled** workspaces (request a **CUI workspace**).\n- Apply the correct **sensitivity label**; labels drive encryption and DLP.\n- Do not email CUI externally or to personal accounts; sharing is restricted by policy.\n- Report suspected spillage immediately as a security incident.' },

      // ----- Microsoft 365 -----
      { space: 'M365', title: 'Microsoft Teams — getting started', labels: ['teams', 'm365'],
        body: '# Teams basics\n\nTeams is your hub for chat, meetings, and files.\n\n- **Chat** for quick 1:1 or group messages; **Teams & channels** for projects.\n- Files shared in a channel live in its SharePoint site.\n- Use **status** and **quiet hours** to manage notifications.\n\nNeed a new Team? See the child article.' },
      { space: 'M365', title: 'Create a Team or channel', labels: ['teams', 'collaboration'], parent: 'Microsoft Teams — getting started',
        body: '# Request a Team or channel\n\nTeams are provisioned from approved templates with the right data label.\n\n1. Submit a **New Team / SharePoint site** request with the name, owners, and **data classification**.\n2. A sponsor approves (classification + external-sharing scope).\n3. We create it from the template and confirm membership and sharing.\n\nFor a sub-topic in an existing Team, an owner can add a **channel** directly.' },
      { space: 'M365', title: 'Share files safely in SharePoint & OneDrive', labels: ['sharepoint', 'onedrive', 'sharing'],
        body: '# Sharing without oversharing\n\n- Prefer **specific people** links over “anyone with the link”.\n- External sharing may be blocked or require approval in gov tenants.\n- Use **sensitivity labels**; they travel with the file and enforce protection.\n- Review access periodically — owners receive access-review tasks.' },
      { space: 'M365', title: 'Shared mailboxes & delegation in Outlook', labels: ['outlook', 'mailbox', 'delegation'],
        body: '# Shared mailboxes & delegation\n\n- Request a **Shared mailbox & distribution list** from the catalog; name the owner and members.\n- Delegates get **send-as** or **full-access** on a least-privilege basis.\n- To auto-map, sign out and back in after access is granted.\n- Calendars can be delegated separately from mail.' },
      { space: 'M365', title: 'Sensitivity labels & Purview DLP', labels: ['purview', 'dlp', 'labels'],
        body: '# Information protection\n\n**Sensitivity labels** classify and protect content (encryption, watermarks, sharing limits). **DLP** policies prevent risky sharing of sensitive data (e.g., CUI, PII).\n\nIf a label or DLP policy blocks legitimate work, request a scoped, time-bound **Purview DLP exception** with data-owner and SecOps approval.' },

      // ----- Cloud Operations -----
      { space: 'CLOUD', title: 'Request Azure access (PIM eligible roles)', labels: ['azure', 'pim', 'access'],
        body: '# Azure access is eligible, not standing\n\nPrivileged Azure roles are granted as **eligible** via PIM — you activate them when needed with MFA + justification.\n\n1. Submit an **Azure RBAC / PIM** request with the role and scope.\n2. Resource owner + SecOps approve.\n3. Activate the role in PIM for the time-boxed window.' },
      { space: 'CLOUD', title: 'AWS GovCloud — Identity Center access', labels: ['aws', 'govcloud', 'access'],
        body: '# AWS access via Identity Center\n\nAccess is granted as **permission sets** scoped to specific accounts.\n\n1. Submit an **AWS IAM Identity Center** request naming the permission set + account.\n2. Account owner + SecOps approve.\n3. Sign in through the access portal; session duration is limited by guardrails (SCPs).' },
      { space: 'CLOUD', title: 'Landing-zone & tagging standards', labels: ['landing-zone', 'tagging', 'governance'],
        body: '# Landing zones & tags\n\nNew subscriptions/accounts are provisioned through governed landing zones with security baselines applied automatically.\n\n**Required tags** (examples): `owner`, `cost-center`, `data-classification`, `environment`. Untagged resources may be flagged or deprovisioned. Request new resources via the Azure/AWS provisioning catalog items.' },

      // ----- Policies & Compliance -----
      { space: 'POL', title: 'Password & MFA policy', labels: ['policy', 'password', 'mfa'],
        body: '# Password & MFA policy\n\n- Minimum length and complexity are enforced; passphrases are encouraged.\n- **MFA is mandatory** under Conditional Access; Authenticator is preferred.\n- Never reuse work passwords elsewhere or share them. Report suspected compromise immediately.' },
      { space: 'POL', title: 'Data classification & retention', labels: ['policy', 'data', 'retention'],
        body: '# Classify and retain correctly\n\nClassify content with the correct sensitivity label (Public, Internal, Confidential, CUI). Retention is applied by label and record type. Do not delete records under legal hold; eDiscovery and holds are managed by the security team.' },
      { space: 'POL', title: 'Continuous Monitoring (ConMon) overview', labels: ['conmon', 'compliance'],
        body: '# What ConMon checks\n\nWe run scheduled checks mapped to NIST 800-53/800-171 controls — MFA coverage, Conditional Access baseline, privileged-access review, vulnerability scans, patch/device compliance, email security, backups, and audit-log health. Failing checks raise posture findings and remediation tickets automatically.' },
      { space: 'POL', title: 'Change management & the CAB', labels: ['change', 'cab', 'policy'],
        body: '# How changes are governed\n\n- **Standard** changes are pre-approved and low-risk.\n- **Normal** changes go through the **Change Advisory Board (CAB)** for multi-party approval and are scheduled in a window (with conflict detection).\n- **Emergency** changes follow an expedited path but are reviewed after the fact.\n\nEvery change records a backout plan.' },
    ];

    for (const p of kbPages) {
      const spaceId = kbSpaceIds[p.space];
      const exists = await sql.query('SELECT 1 FROM kb_pages WHERE space_id=$1 AND organization_id IS NULL AND title=$2', [spaceId, p.title]);
      if (exists.rows[0]) continue;
      const parentId = p.parent
        ? (await sql.query('SELECT id FROM kb_pages WHERE space_id=$1 AND organization_id IS NULL AND title=$2', [spaceId, p.parent])).rows[0]?.id ?? null
        : null;
      const pg = (
        await sql.query(
          `INSERT INTO kb_pages (organization_id, space_id, parent_id, title, body, labels, author_id, updated_by, version, status, published_at)
           VALUES (NULL,$1,$2,$3,$4,$5,$6,$6,1,'published', now()) RETURNING id`,
          [spaceId, parentId, p.title, p.body, p.labels, kbAuthor],
        )
      ).rows[0].id;
      await sql.query(`INSERT INTO kb_page_versions (page_id, version, title, body, edited_by) VALUES ($1,1,$2,$3,$4)`, [pg, p.title, p.body, kbAuthor]);
    }

    // ---- Default global agent queues (SLA-aware) ----
    const queueCount = await sql.query('SELECT count(*)::int AS n FROM queues');
    if (queueCount.rows[0].n === 0) {
      const queues: Array<[string, object, string]> = [
        ['Unassigned', { unassigned: true, status: ['new', 'triage', 'assigned'] }, 'sla'],
        ['P1 incidents', { priority: 'P1' }, 'sla'],
        ['In progress', { status: 'in_progress' }, 'sla'],
        ['Security', { tag: 'security' }, 'priority'],
      ];
      for (const [name, def, orderBy] of queues) {
        await sql.query(`INSERT INTO queues (organization_id, name, definition, order_by, created_by) VALUES (NULL,$1,$2,$3,$4)`, [name, JSON.stringify(def), orderBy, kbAuthor]);
      }
    }

    // ===================== DEMO data (gated) =====================
    if (seedDemo && demoOrgId && demoCustomerId) {
      const existing = await sql.query("SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1", [demoOrgId]);
      if (existing.rows[0].n === 0) {
        for (const [num, subject, priority, status] of [
          ['DEMO-000001', 'Cannot access email on mobile', 'P2', 'in_progress'],
          ['DEMO-000002', 'Request: new laptop for hire', 'P3', 'assigned'],
          ['DEMO-000003', 'VPN drops every few minutes', 'P2', 'triage'],
        ] as const) {
          await sql.query(
            `INSERT INTO tickets (organization_id, ticket_number, type, requester_id, source_channel, subject, priority, status, response_due_at, resolution_due_at)
             VALUES ($1,$2,'incident',$3,'portal',$4,$5,$6, now()+interval '1 hour', now()+interval '8 hours')`,
            [demoOrgId, num, demoCustomerId, subject, priority, status],
          );
        }

        // ---- Synthetic historical tickets (power the analytics dashboard) ----
        const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
        const weighted = <T,>(pairs: ReadonlyArray<readonly [T, number]>): T => {
          const total = pairs.reduce((s, [, w]) => s + w, 0);
          let r = Math.random() * total;
          for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
          return pairs[0][0];
        };
        const categories = [
          ['System', 0.4, 7.5],
          ['Login Access', 0.3, 0.33],
          ['Software', 0.2, 5.0],
          ['Hardware', 0.1, 6.5],
        ] as const;
        const years: ReadonlyArray<readonly [number, number]> = [[2016, 13], [2017, 15], [2018, 19], [2019, 21], [2020, 29]];

        const batch: string[] = [];
        const values: unknown[] = [];
        let seq = 1000;
        const flush = async () => {
          if (!batch.length) return;
          await sql.query(
            `INSERT INTO tickets
              (organization_id, ticket_number, type, requester_id, assigned_agent_id, source_channel,
               subject, category, priority, severity, status, custom_fields, satisfaction_score, created_at, resolved_at)
              VALUES ${batch.join(',')}`,
            values,
          );
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
          const resDays = Math.max(0.05, resMean * (0.5 + Math.random()));
          const resolved = new Date(created.getTime() + resDays * 86400000);
          const sat = Math.max(1, Math.min(5, Math.round(5 - resDays / 4 + (Math.random() - 0.5))));

          const base = values.length;
          batch.push(
            `($${base + 1},$${base + 2},'incident',$${base + 3},$${base + 4},'portal',$${base + 5},$${base + 6},$${base + 7},$${base + 8},'closed',$${base + 9},$${base + 10},$${base + 11},$${base + 12})`,
          );
          values.push(
            demoOrgId,
            `DEMO-${String(++seq).padStart(6, '0')}`,
            demoCustomerId,
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

      // ---- On-call schedule (weekly primary rotation over desk agents) ----
      const schedExists = await sql.query("SELECT id FROM oncall_schedules WHERE team=$1", ['Service Desk On-Call']);
      if (!schedExists.rows[0] && agentIds.length >= 5) {
        const scheduleId = (
          await sql.query("INSERT INTO oncall_schedules (team, tz, coverage) VALUES ('Service Desk On-Call','America/New_York','24x7') RETURNING id")
        ).rows[0].id;
        const rot = (
          await sql.query("INSERT INTO oncall_rotations (schedule_id, role, length_days, handoff_epoch) VALUES ($1,'primary',7, '2026-01-05T09:00:00Z') RETURNING id", [scheduleId])
        ).rows[0].id;
        const responders = agentIds.slice(0, 5);
        for (let i = 0; i < responders.length; i++) {
          await sql.query('INSERT INTO oncall_participants (rotation_id, user_id, position) VALUES ($1,$2,$3)', [rot, responders[i], i]);
        }
      }

      // ---- Demo posture findings ----
      const fcount = await sql.query("SELECT count(*)::int AS n FROM posture_findings WHERE organization_id=$1", [demoOrgId]);
      if (fcount.rows[0].n === 0) {
        const profile = (await sql.query('SELECT id FROM posture_profiles WHERE organization_id=$1', [demoOrgId])).rows[0].id;
        for (const [title, domain, severity] of [
          ['12% of users without MFA', 'mfa', 'high'],
          ['Legacy auth protocols enabled', 'identity', 'critical'],
          ['3 devices non-compliant in Intune', 'device', 'moderate'],
          ['DMARC policy set to none', 'email', 'high'],
        ] as const) {
          await sql.query(
            `INSERT INTO posture_findings (organization_id, profile_id, title, domain, severity, risk_score, status, remediation_due_at)
             VALUES ($1,$2,$3,$4,$5,$6,'confirmed', now()+interval '30 days')`,
            [demoOrgId, profile, title, domain, severity, severity === 'critical' ? 40 : severity === 'high' ? 25 : 12],
          );
        }
      }
    }
  });
  logger.info(seedDemo ? 'seed complete (platform + demo)' : 'seed complete (platform only; SEED_DEMO=0)');
  process.exit(0);
}

run().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
