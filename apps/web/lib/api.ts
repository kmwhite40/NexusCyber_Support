// Browser API client. Stores the dev session token in localStorage and sends it as
// a Bearer token. (In production this is replaced by httpOnly cookie sessions from
// the OIDC flow — see docs/nexus/02 §E.10. localStorage is a dev-only convenience.)

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api/v1';
const TOKEN_KEY = 'nexus_token';

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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
  request: (key: string, body: { subject?: string; description?: string; organizationId?: string }) =>
    api.post<Ticket>(`/catalog/${key}/request`, body),
};

export const conmon = {
  runs: () => api.get<{ data: ConMonRun[] }>('/conmon/runs'),
  run: () => api.post<{ orgs: number; checks: number; findings: number }>('/conmon/run'),
};

export interface OnCallSchedule {
  id: string;
  team: string;
  tz: string;
  coverage: string;
  rotationLengthDays: number | null;
  current: { name: string; via: string } | null;
  participants: Array<{ user_id: string; position: number; name: string }>;
}
export interface Responder {
  id: string;
  name: string;
  email: string;
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

export const analytics = {
  overview: () => api.get<AnalyticsOverview>('/analytics/overview'),
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
};

export interface ServiceRow { id: string; organization_id: string; name: string; kind: string; ticket_count: number; }
export interface ConfigurationItem { id: string; organization_id: string; ci_class: string; name: string; criticality: number; status: string; ticket_count: number; }
export const servicesApi = {
  list: () => api.get<{ data: ServiceRow[] }>('/services').then((r) => r.data),
  create: (b: { name: string; kind?: string; organizationId?: string }) => api.post<ServiceRow>('/services', b),
  cis: (q = '') => api.get<{ data: ConfigurationItem[] }>(`/configuration-items${q}`).then((r) => r.data),
  createCi: (b: { name: string; ciClass: string; criticality?: string | number; status?: string; organizationId?: string }) => api.post<ConfigurationItem>('/configuration-items', b),
};

export interface OrgDetail { id: string; name: string; cloud: string; data_boundary?: string; user_count: number; open_tickets: number; }
export interface OrgUser { id: string; email: string; display_name: string | null; status: string; }
export interface OrgSummary { id: string; name: string; cloud?: string; }
export const customersApi = {
  list: () => api.get<{ data: OrgSummary[] }>('/organizations').then((r) => r.data),
  get: (id: string) => api.get<OrgDetail>(`/organizations/${id}`),
  users: (id: string) => api.get<{ data: OrgUser[] }>(`/organizations/${id}/users`).then((r) => r.data),
  update: (id: string, b: { name?: string; cloud?: string; dataBoundary?: string }) => api.patch<OrgDetail>(`/organizations/${id}`, b),
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
