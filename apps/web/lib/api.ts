// Browser API client. Stores the dev session token in localStorage and sends it as
// a Bearer token. (In production this is replaced by httpOnly cookie sessions from
// the OIDC flow — see docs/nexus/02 §E.10. localStorage is a dev-only convenience.)

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api/v1';
const TOKEN_KEY = 'nexus_token';

/** API base URL — used for top-level navigations like the OIDC SSO start endpoint. */
export const API_BASE = BASE;
/** Full URL the agent "Sign in with Microsoft (Gov)" button navigates to. */
export const oidcStartUrl = `${BASE}/auth/oidc/start`;
/** Full URL the customer "Sign in with your organization" button navigates to. */
export const oidcCustomerStartUrl = `${BASE}/auth/oidc/start?mode=customer`;

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  // Only declare a JSON content-type when we actually send a body — a Content-Type
  // with an empty body makes the server's JSON parser reject the request.
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, data?.detail ?? data?.title ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body),
  put: <T>(p: string, body?: unknown) => request<T>('PUT', p, body),
  patch: <T>(p: string, body?: unknown) => request<T>('PATCH', p, body),
  del: <T>(p: string) => request<T>('DELETE', p),
};

// ---- Typed helpers ----
/** Landing route after auth: customers get the support portal, agents the control plane. */
export function homePath(plane: 'nexus' | 'customer' | undefined): string {
  return plane === 'customer' ? '/portal' : '/dashboard';
}

export interface Me {
  id: string;
  plane: 'nexus' | 'customer';
  email: string;
  organization_id: string | null;
  roles: string[];
  capabilities: string[];
  assigned_orgs?: string[];
  all_orgs?: boolean;
}
export interface Ticket {
  id: string;
  ticket_number: string;
  organization_id: string;
  type: string;
  subject: string;
  description?: string;
  status: string;
  priority: string;
  severity?: string;
  assigned_agent_id?: string | null;
  response_due_at?: string | null;
  resolution_due_at?: string | null;
  tags: string[];
  created_at: string;
  category?: string;
  assignment_group_id?: string | null;
  comments?: Array<{ id: string; body: string; visibility: string; created_at: string; author_id: string }>;
  events?: Array<{ id: string; event_type: string; detail: any; created_at: string }>;
  slas?: Array<{ id: string; metric: string; state: string; due_at: string }>;
  tasks?: Array<{ id: string; step_key: string; label: string; assignee_role: string | null; status: string; automatable: boolean; position: number }>;
  approvals?: Array<{ id: string; status: string }>;
  parent_ticket_id?: string | null;
  links?: Array<{ id: string; direction: 'outgoing' | 'incoming'; label: string; link_type: string; other_id: string; other_number: string; other_subject: string }>;
}

export const LINK_TYPES = ['related_to', 'duplicate_of', 'caused_by', 'blocks', 'child_of'] as const;

export interface CatalogItem {
  key: string;
  name: string;
  category: string;
  description?: string;
  ticket_type: string;
  owning_tier: string;
  escalates_to: string | null;
  requires_approval: boolean;
  approver_hint: string | null;
  default_priority: string;
  security_class: string;
  sla_response_min: number;
  sla_resolution_min: number;
  fulfillment_steps: Array<{ key: string; label: string; role: string; automatable?: boolean }>;
}

export type VisibleWhen = { field: string; equals: string } | { field: string; in: string[] };

export interface FormFieldDef {
  key: string;
  label: string;
  data_type:
    // Mirrors FieldType in apps/api/src/modules/form-fields.ts — keep the two in step.
    | 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date' | 'datetime'
    | 'user' | 'user_multi' | 'attachment' | 'email' | 'phone';
  required: boolean;
  options: string[];
  visible_when: VisibleWhen | null;
  sensitive: boolean;
  options_source: string | null;
}
export interface CatalogForm {
  id: string;
  key: string;
  name: string;
  fields: FormFieldDef[];
}
export interface UserHit { id: string; display_name: string | null; email: string }

export interface ConMonRun {
  check_key: string;
  result: string;
  ran_at: string;
  name: string | null;
  domain: string | null;
  severity: string | null;
  control_refs: string[] | null;
}

export const catalog = {
  list: () => api.get<{ data: CatalogItem[] }>('/catalog'),
  form: (key: string) => api.get<{ form: CatalogForm | null }>(`/catalog/${key}/form`),
  request: (
    key: string,
    body: { subject?: string; description?: string; organizationId?: string; answers?: Record<string, unknown> },
  ) => api.post<Ticket>(`/catalog/${key}/request`, body),
};

export const users = {
  search: (q: string, organizationId?: string) =>
    api.get<{ data: UserHit[] }>(
      `/users/search?q=${encodeURIComponent(q)}${organizationId ? `&organizationId=${organizationId}` : ''}`,
    ),
};

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  scan_status: string;
  created_at: string;
}

export const attachmentsApi = {
  list: (ticketId: string) => api.get<{ data: Attachment[] }>(`/tickets/${ticketId}/attachments`),

  /** Stream a clean attachment to the browser as a download (carries the session auth). */
  download: async (id: string, filename: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`${BASE}/attachments/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = res.statusText;
      try { detail = JSON.parse(text)?.detail ?? detail; } catch { /* ignore */ }
      throw new ApiError(res.status, detail);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /** Multipart upload — the attachments route reads a single file field. */
  upload: async (ticketId: string, file: File): Promise<void> => {
    const form = new FormData();
    form.append('file', file);
    const token = getToken();
    const res = await fetch(`${BASE}/tickets/${ticketId}/attachments`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = res.statusText;
      try { detail = JSON.parse(text)?.detail ?? detail; } catch { /* ignore */ }
      throw new ApiError(res.status, detail);
    }
  },
};

export const conmon = {
  runs: (orgId?: string) => api.get<{ data: ConMonRun[] }>(`/conmon/runs${orgId ? `?organizationId=${orgId}` : ''}`),
  run: (orgId?: string) => api.post<{ orgs: number; checks: number; findings: number }>(`/conmon/run${orgId ? `?organizationId=${orgId}` : ''}`),
};

export interface OnCallSchedule {
  id: string;
  team: string;
  tz: string;
  coverage: string;
  rotationLengthDays: number | null;
  current: { name: string; via: string; phone?: string | null } | null;
  participants: Array<{ user_id: string; position: number; name: string; phone: string | null }>;
}
export interface Responder {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
}
export interface OnCallPage {
  id: string;
  severity: string;
  state: string;
  created_at: string;
  ack_deadline_at: string | null;
  ticket_id: string | null;
  responder: string | null;
  org: string | null;
  acked_at: string | null;
}

export const oncall = {
  schedules: () => api.get<{ data: OnCallSchedule[] }>('/oncall/schedules'),
  pages: () => api.get<{ data: OnCallPage[] }>('/oncall/pages'),
  responders: () => api.get<{ data: Responder[] }>('/oncall/responders'),
  createPage: (body: { severity?: string; ticketId?: string; organizationId?: string }) => api.post<OnCallPage>('/oncall/pages', body),
  ack: (id: string) => api.post<{ state: string }>(`/oncall/pages/${id}/ack`),
  escalatePage: (id: string) => api.post<{ state: string; responder?: string }>(`/oncall/pages/${id}/escalate`),
  createSchedule: (body: { team: string; lengthDays?: number; participantIds: string[]; tz?: string; coverage?: string }) =>
    api.post<{ id: string }>('/oncall/schedules', body),
  updateRotation: (id: string, body: { lengthDays?: number; participantIds: string[] }) =>
    api.patch<{ ok: boolean }>(`/oncall/schedules/${id}`, body),
  createOverride: (body: { scheduleId: string; userId: string; startsAt: string; endsAt: string; reason?: string }) =>
    api.post<{ ok: boolean }>('/oncall/overrides', body),
  deleteSchedule: (id: string) => api.del<{ ok: boolean }>(`/oncall/schedules/${id}`),
  removeParticipant: (id: string, userId: string) => api.del<{ ok: boolean; remaining: number }>(`/oncall/schedules/${id}/participants/${userId}`),
  setResponderPhone: (userId: string, phone: string | null) => api.patch<{ ok: boolean; phone: string | null }>(`/oncall/responders/${userId}`, { phone }),
};

// Tier groups available as escalation targets (mirrors seeded assignment_groups).
export const TIER_GROUPS = [
  'Tier 1 — Helpdesk Analyst',
  'Tier 2 — M365 Administrator',
  'Security Operations',
  'Engagement Management',
];
export interface Finding {
  id: string;
  title: string;
  domain: string;
  severity: string;
  risk_score: number;
  status: string;
  remediation_due_at?: string | null;
  linked_ticket_id?: string | null;
}

export interface AnalyticsOverview {
  kpis: { totalTickets: number; avgResolutionDays: number; withinSlaPct: number; avgRating: number; totalAgents: number };
  yoyTicketsPct: number;
  volumeByYear: Array<{ year: number; count: number }>;
  byCategory: Array<{ category: string; total: number; avgResolutionDays: number; withinSlaPct: number }>;
  byPriority: Array<{ label: string; count: number }>;
  bySeverity: Array<{ label: string; count: number }>;
  issueBreakdown: Array<{
    klass: string;
    total: number;
    pctOfGrand: number;
    categories: Array<{ category: string; total: number; pctOfClass: number; avgResolutionDays: number; withinSlaPct: number }>;
  }>;
  agents: Array<{ agentId: string; name: string; tickets: number; avgResolutionDays: number; withinSlaPct: number; avgRating: number }>;
  topRated: AnalyticsOverview['agents'];
  worstRated: AnalyticsOverview['agents'];
  topByTickets: AnalyticsOverview['agents'];
  bottomByTickets: AnalyticsOverview['agents'];
  scatter: Array<{ resolutionDays: number; avgRating: number; tickets: number }>;
}

export interface OperationalKpis {
  days: number;
  summary: {
    open: number; open_p1: number; opened_today: number; closed_today: number;
    opened_week: number; closed_week: number; mttr_days: number; csat: number;
  };
  trend: Array<{ date: string; opened: number; closed: number }>;
  sla: {
    responseMet: number; responseBreached: number; resolutionMet: number; resolutionBreached: number;
    responseAttainmentPct: number; resolutionAttainmentPct: number; overallAttainmentPct: number;
  };
  byStatus: Array<{ label: string; count: number }>;
  byPriority: Array<{ label: string; count: number }>;
  byAge: Array<{ label: string; count: number }>;
}

export interface CustomerPortfolioRow {
  id: string; name: string; open: number; open_p1: number; opened_7d: number; closed_7d: number; csat: number; slaAttainmentPct: number;
}
export interface PostureCompliance {
  sev: Array<{ label: string; count: number }>;
  totals: { open: number; remediated: number; overdue: number; open_high: number };
  conmon: Array<{ label: string; count: number }>;
  compliance: { families: Array<{ family: string; satisfied: number; partial: number; gap: number }>; satisfiedPct: number };
}
export interface OpsSummary {
  pages: { total: number; acknowledged: number; escalated: number; open: number; last_7d: number; mttaMin: number };
  change: { byType: Array<{ label: string; count: number }>; in_cab: number; approved: number; upcoming: number; rejected: number; closed: number };
}

export interface DeliveryHealth {
  days: number;
  totals: { total: number; sent: number; failed: number; substituted: number; skipped: number };
  byStatus: Array<{ label: string; count: number }>;
  byChannel: Array<{ label: string; count: number }>;
  byEvent: Array<{ label: string; count: number }>;
  recentIssues: Array<{ event_type: string; channel: string; recipient: string | null; status: string; substitution_reason: string | null; created_at: string }>;
  emailSent: number;
}

export const analytics = {
  overview: () => api.get<AnalyticsOverview>('/analytics/overview'),
  notificationHealth: (days = 7) => api.get<DeliveryHealth>(`/notifications/health?days=${days}`),
  kpis: (days = 30, organizationId?: string) =>
    api.get<OperationalKpis>(`/analytics/kpis?days=${days}${organizationId ? `&organizationId=${organizationId}` : ''}`),
  customerPortfolio: () => api.get<{ data: CustomerPortfolioRow[] }>('/analytics/customer-portfolio').then((r) => r.data),
  postureCompliance: (organizationId?: string) =>
    api.get<PostureCompliance>(`/analytics/posture-compliance${organizationId ? `?organizationId=${organizationId}` : ''}`),
  opsSummary: (organizationId?: string) =>
    api.get<OpsSummary>(`/analytics/ops-summary${organizationId ? `?organizationId=${organizationId}` : ''}`),
  reportFields: () => api.get<{ dimensions: string[]; measures: string[] }>('/analytics/report/fields'),
  report: (q: { dimension: string; measure: string; days?: number; status?: string; priority?: string; type?: string }) => {
    const params = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== '') params.set(k, String(v)); });
    return api.get<ReportResult>(`/analytics/report?${params.toString()}`);
  },
};
export interface ReportResult { dimension: string; measure: string; days: number; rows: Array<{ label: string; value: number }>; }

export interface AssistResult {
  query: string;
  answer: { id: string; title: string; snippet: string } | null;
  articles: Array<{ id: string; title: string; snippet: string }>;
  services: Array<{ key: string; name: string; category: string }>;
  deflect: boolean;
}
export const assistApi = {
  ask: (q: string) => api.get<AssistResult>(`/assist?q=${encodeURIComponent(q)}`),
};

export interface AutomationRule {
  id: string;
  name: string;
  state: 'draft' | 'testing' | 'published' | 'disabled';
  version: number;
  organization_id: string | null;
  created_at: string;
  definition: {
    trigger: { event: string };
    conditions?: { all?: Array<{ field: string; op: string; value?: unknown }>; any?: Array<{ field: string; op: string; value?: unknown }> };
    actions: Array<{ type: string; [k: string]: unknown }>;
  };
}
export interface SimResult {
  matched: boolean;
  intended_actions: Array<{ action: { type: string; [k: string]: unknown }; performed: boolean; gated: boolean }>;
}

export const automation = {
  list: () => api.get<{ data: AutomationRule[] }>('/automations'),
  create: (body: { name: string; definition: AutomationRule['definition'] }) => api.post<AutomationRule>('/automations', body),
  simulate: (id: string, event: Record<string, unknown>) => api.post<SimResult>(`/automations/${id}/simulate`, { event }),
  publish: (id: string) => api.post<{ state: string }>(`/automations/${id}/publish`),
  setState: (id: string, state: 'draft' | 'disabled') => api.post<{ state: string }>(`/automations/${id}/state`, { state }),
  executions: (id: string) => api.get<{ data: Array<{ id: string; trigger_event: string; outcome: string; steps: unknown; created_at: string }> }>(`/automations/${id}/executions`),
};

export const auth = {
  me: () => api.get<Me>('/me'),
  devUsers: () => api.get<{ users: Array<{ email: string; display_name: string; plane: string; org: string | null; roles: string[] }> }>('/auth/dev-users'),
  devLogin: (email: string) => api.post<{ token: string; principal: Me }>('/auth/dev-login', { email }),
  login: (email: string, password: string) => api.post<{ token: string; principal: Me }>('/auth/login', { email, password }),
  register: (input: { organizationName: string; email: string; displayName?: string; password: string; cloud?: string }) =>
    api.post<{ token: string; principal: Me }>('/auth/register', input),
  config: () =>
    api.get<{
      oidcEnabled: boolean;
      oidcLabel: string;
      customerOidcEnabled: boolean;
      customerOidcLabel: string;
    }>('/auth/config'),
};

export interface ServiceRow { id: string; organization_id: string; name: string; kind: string; ticket_count: number; }
export interface ConfigurationItem { id: string; organization_id: string; ci_class: string; name: string; criticality: number; status: string; ticket_count: number; owner?: string | null; support_group?: string | null; attributes?: Record<string, unknown>; }
export const CI_REL_TYPES = ['depends_on', 'runs_on', 'hosts', 'connects_to', 'member_of', 'uses'] as const;
export type CiRelType = (typeof CI_REL_TYPES)[number];
export interface CiRelationship { id: string; rel_type: CiRelType; ci_id: string; name: string; ci_class: string; }
export interface ConfigurationItemDetail extends ConfigurationItem {
  attributes: Record<string, unknown>;
  relationships: { outgoing: CiRelationship[]; incoming: CiRelationship[] };
}
export const servicesApi = {
  list: () => api.get<{ data: ServiceRow[] }>('/services').then((r) => r.data),
  create: (b: { name: string; kind?: string; organizationId?: string }) => api.post<ServiceRow>('/services', b),
  cis: (q = '') => api.get<{ data: ConfigurationItem[] }>(`/configuration-items${q}`).then((r) => r.data),
  createCi: (b: { name: string; ciClass: string; criticality?: string | number; status?: string; owner?: string; supportGroup?: string; attributes?: Record<string, unknown>; organizationId?: string }) => api.post<ConfigurationItem>('/configuration-items', b),
  ci: (id: string) => api.get<ConfigurationItemDetail>(`/configuration-items/${id}`),
  updateCi: (id: string, b: { criticality?: string | number; status?: string; owner?: string | null; supportGroup?: string | null; attributes?: Record<string, unknown> }) => api.patch<ConfigurationItem>(`/configuration-items/${id}`, b),
  addRel: (b: { sourceId: string; targetId: string; relType: CiRelType }) => api.post<CiRelationship>('/ci-relationships', b),
  removeRel: (id: string) => api.del<{ deleted: boolean }>(`/ci-relationships/${id}`),
};

export interface OrgDetail { id: string; name: string; cloud: string; data_boundary?: string; status?: string; entra_tenant_id?: string | null; user_count: number; open_tickets: number; }
export interface OrgUser { id: string; email: string; display_name: string | null; status: string; roles?: string[]; }
export interface OrgSummary { id: string; name: string; cloud?: string; status?: string; entra_tenant_id?: string | null; }
export type Cloud = 'commercial' | 'gcc' | 'gcchigh' | 'azgov';
/** Customer-plane roles assignable in the admin UI. */
export const CUSTOMER_ROLES = ['OrgAdmin', 'EndUser', 'SecurityContact'] as const;
export const customersApi = {
  list: () => api.get<{ data: OrgSummary[] }>('/organizations').then((r) => r.data),
  get: (id: string) => api.get<OrgDetail>(`/organizations/${id}`),
  users: (id: string) => api.get<{ data: OrgUser[] }>(`/organizations/${id}/users`).then((r) => r.data),
  create: (b: { name: string; cloud?: Cloud; entraTenantId?: string }) => api.post<OrgDetail>('/organizations', b),
  update: (id: string, b: { name?: string; cloud?: Cloud; entraTenantId?: string | null; status?: string }) => api.patch<OrgDetail>(`/organizations/${id}`, b),
  remove: (id: string, force?: boolean) => api.del<{ deleted: boolean }>(`/organizations/${id}${force ? '?force=true' : ''}`),
  addUser: (orgId: string, b: { email: string; displayName?: string; roleKey?: string; password?: string }) => api.post<{ id: string }>(`/organizations/${orgId}/users`, b),
  updateUser: (orgId: string, userId: string, b: { status?: 'active' | 'suspended'; roleKey?: string }) => api.patch<{ id: string }>(`/organizations/${orgId}/users/${userId}`, b),
  removeUser: (orgId: string, userId: string) => api.del<{ id: string }>(`/organizations/${orgId}/users/${userId}`),
};

// ---- Billing (admin-only; per-customer allocation + overage) ----
export interface BillingSettings {
  organization_id: string;
  plan_name: string;
  monthly_ticket_allocation: number;
  overage_fee_cents: number;
  currency: string;
  updated_at: string | null;
}
export interface BillingUtilization {
  organization_id: string;
  organization_name: string;
  year: number;
  month: number;
  period_start: string;
  period_end: string;
  used: number;
  allocation: number;
  overage: number;
  overage_fee_cents: number;
  amount_cents: number;
  currency: string;
  plan_name: string;
}
export const billingApi = {
  settings: (orgId: string) => api.get<BillingSettings>(`/billing/settings?organizationId=${orgId}`),
  saveSettings: (b: { organizationId: string; planName: string; monthlyTicketAllocation: number; overageFeeCents: number; currency: string }) =>
    api.put<BillingSettings>('/billing/settings', b),
  utilization: (orgId: string, year: number, month: number) =>
    api.get<BillingUtilization>(`/billing/utilization?organizationId=${orgId}&year=${year}&month=${month}`),
};

// ---- Platform user administration (nexus staff) ----
export interface PlatformUser {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  has_password: boolean;
  roles: string[];
  all_orgs: boolean;
  org_ids: string[];
  created_at: string;
}
export type OrgScope = { mode: 'all' } | { mode: 'orgs'; orgIds: string[] };

// ---- Per-customer Entra/Intune device sync ----
// The client secret is write-only by design: it is POSTed on configure and never returned by
// status, so nothing in this client can put it back on screen.
export interface EntraIntegration {
  organization_id: string;
  tenant_id: string;
  client_id: string;
  enabled: boolean;
  status: 'unconfigured' | 'ok' | 'error';
  last_sync_at: string | null;
  last_error: string | null;
  last_sync_stats: { created: number; updated: number; retired: number; skippedRetirement?: boolean; skipReason?: string } | null;
  updated_at: string;
}

export interface EntraSyncRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  created_count: number;
  updated_count: number;
  retired_count: number;
  status: 'ok' | 'error';
  error: string | null;
}

export interface EntraSyncStats {
  created: number;
  updated: number;
  retired: number;
  skippedRetirement: boolean;
  /** Why retirement was skipped, when it was. Shown verbatim — it names what to check. */
  skipReason?: string;
}

export const entraApi = {
  status: (orgId: string) =>
    api.get<{ integration: EntraIntegration | null; runs: EntraSyncRun[] }>(`/integrations/entra/${orgId}/status`),
  configure: (b: { organizationId: string; tenantId: string; clientId: string; clientSecret: string }) =>
    api.post<{ ok: true }>('/integrations/entra/config', b),
  test: (orgId: string) => api.post<{ ok: boolean; error?: string }>(`/integrations/entra/${orgId}/test`, {}),
  setEnabled: (orgId: string, enabled: boolean) =>
    api.post<{ ok: true }>(`/integrations/entra/${orgId}/enable`, { enabled }),
  sync: (orgId: string) => api.post<EntraSyncStats>(`/integrations/entra/${orgId}/sync`, {}),
};

export const platformUsersApi = {
  list: () => api.get<{ data: PlatformUser[]; assignable_roles: string[] }>('/platform/users'),
  create: (b: { email: string; displayName?: string; roleKeys?: string[]; password?: string; scope?: OrgScope }) =>
    api.post<{ id: string }>('/platform/users', b),
  update: (id: string, b: { status?: 'active' | 'suspended'; displayName?: string; password?: string }) =>
    api.patch<{ id: string }>(`/platform/users/${id}`, b),
  setRoles: (id: string, roleKeys: string[]) => api.put<{ id: string }>(`/platform/users/${id}/roles`, { roleKeys }),
  setScope: (id: string, scope: OrgScope) => api.put<{ id: string }>(`/platform/users/${id}/scope`, scope),
};

export interface Delivery {
  id: string;
  event_type: string;
  channel: string;
  recipient: string;
  status: string;
  substitution_reason: string | null;
  provider_message_id: string | null;
  created_at: string;
}
export const emailLogApi = {
  list: (q = '') => api.get<{ data: Delivery[] }>(`/notifications/deliveries${q}`).then((r) => r.data),
};

export interface Alert { id: string; organization_id: string; source: string; dedup_key: string | null; severity: string; state: string; summary: string; acknowledged_at: string | null; resolved_at: string | null; escalated_page_id: string | null; escalated_ticket_id: string | null; created_at: string; }
export const alertsApi = {
  list: (q = '') => api.get<{ data: Alert[] }>(`/alerts${q}`).then((r) => r.data),
  create: (b: { summary: string; severity?: string; source?: string; dedupKey?: string; organizationId?: string }) => api.post<Alert>('/alerts', b),
  ack: (id: string) => api.post<Alert>(`/alerts/${id}/ack`),
  resolve: (id: string) => api.post<Alert>(`/alerts/${id}/resolve`),
  escalate: (id: string, b: { toPage?: boolean; toTicket?: boolean }) => api.post(`/alerts/${id}/escalate`, b),
};

export interface Channel { id: string; organization_id: string; type: string; name: string; config: Record<string, unknown>; enabled: boolean; created_at: string; }
export const channelsApi = {
  list: () => api.get<{ data: Channel[] }>('/channels').then((r) => r.data),
  create: (b: { type: string; name: string; config?: Record<string, unknown>; enabled?: boolean; organizationId?: string }) => api.post<Channel>('/channels', b),
  update: (id: string, b: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) => api.patch<Channel>(`/channels/${id}`, b),
};

export interface Dashboard { id: string; organization_id: string; owner_user_id: string | null; name: string; layout: { type: string }[]; is_default: boolean; }
export const dashboardsApi = {
  list: () => api.get<{ data: Dashboard[] }>('/dashboards').then((r) => r.data),
  create: (b: { name: string; layout?: { type: string }[]; organizationId?: string }) => api.post<Dashboard>('/dashboards', b),
  update: (id: string, b: { name?: string; layout?: { type: string }[] }) => api.patch<Dashboard>(`/dashboards/${id}`, b),
  remove: (id: string) => api.del<{ ok: true }>(`/dashboards/${id}`),
};

export interface EscalationStep { order: number; targetType: 'schedule' | 'user'; targetId: string; delayMinutes: number; }
export interface EscalationPolicy { id: string; organization_id: string; name: string; steps: EscalationStep[]; created_at: string; }
export const escalationApi = {
  list: () => api.get<{ data: EscalationPolicy[] }>('/escalation-policies').then((r) => r.data),
  create: (b: { name: string; steps: { targetType: string; targetId: string; delayMinutes: number }[]; organizationId?: string }) => api.post<EscalationPolicy>('/escalation-policies', b),
  update: (id: string, b: { name?: string; steps?: { targetType: string; targetId: string; delayMinutes: number }[] }) => api.patch<EscalationPolicy>(`/escalation-policies/${id}`, b),
  remove: (id: string) => api.del<{ ok: true }>(`/escalation-policies/${id}`),
};
