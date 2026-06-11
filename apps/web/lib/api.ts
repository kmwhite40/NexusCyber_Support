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
};

// ---- Typed helpers ----
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
}

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

export const auth = {
  me: () => api.get<Me>('/me'),
  devUsers: () => api.get<{ users: Array<{ email: string; display_name: string; plane: string; org: string | null; roles: string[] }> }>('/auth/dev-users'),
  devLogin: (email: string) => api.post<{ token: string; principal: Me }>('/auth/dev-login', { email }),
  login: (email: string, password: string) => api.post<{ token: string; principal: Me }>('/auth/login', { email, password }),
  register: (input: { organizationName: string; email: string; displayName?: string; password: string; cloud?: string }) =>
    api.post<{ token: string; principal: Me }>('/auth/register', input),
};
