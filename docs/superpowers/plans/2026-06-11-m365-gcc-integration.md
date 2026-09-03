# M365 GCC Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stubbed notification send path with a real Microsoft 365 GCC integration (outbound email, inbound mail→ticket ingestion, Teams posting, health/test) for a single enclave service mailbox, config-wired with a dev console transport.

**Architecture:** A self-contained `apps/api/src/integrations/m365/` directory holds the token provider, Graph HTTP client, and channel adapters behind a `NotificationAdapter` interface. The dispatcher resolves recipients from domain context, renders per-event templates, and sends through the selected adapter (real Graph when enabled, console otherwise). Per-cloud endpoints come from the existing `cloud_environments` table; credentials come from env config. A polling+delta job ingests inbound mail. Raw `fetch` only — no new dependencies.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify, `pg`, Node 20 global `fetch`, vitest. Microsoft Graph v1.0 REST + OAuth2 client-credentials.

**Reference spec:** [docs/superpowers/specs/2026-06-11-m365-gcc-integration-design.md](../specs/2026-06-11-m365-gcc-integration-design.md)

---

## Conventions for every task

- All TS uses ESM with `.js` import specifiers (e.g. `import { logger } from '../logger.js'`).
- Run commands from `apps/api/`. Tests: `npm test`. Typecheck: `npm run typecheck`.
- Commit after each task with the message shown.
- Functions that touch the DB take a `Sql` (a `pg.PoolClient`) parameter so they can be unit-tested with a fake. Network functions take an injected `fetchImpl`/`getToken`/`sleep` for the same reason.

---

# TIER 1 — Foundation

## Task 1: M365 config block

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `.env.example`
- Test: `apps/api/test/m365-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseM365Config } from '../src/config.js';

describe('parseM365Config', () => {
  it('is disabled with no env', () => {
    const c = parseM365Config({});
    expect(c.enabled).toBe(false);
    expect(c.cloud).toBe('gcc');
  });

  it('parses a full enabled config', () => {
    const c = parseM365Config({
      M365_ENABLED: 'true',
      M365_CLOUD: 'gcc',
      M365_TENANT_ID: 't-1',
      M365_CLIENT_ID: 'c-1',
      M365_CLIENT_SECRET: 's-1',
      M365_SERVICE_MAILBOX: 'svc@agency.gov',
      M365_INGEST_ENABLED: 'true',
      M365_TEAMS_ENABLED: 'false',
    });
    expect(c.enabled).toBe(true);
    expect(c.tenantId).toBe('t-1');
    expect(c.serviceMailbox).toBe('svc@agency.gov');
    expect(c.ingestEnabled).toBe(true);
    expect(c.teamsEnabled).toBe(false);
  });

  it('treats enabled=true but missing secret as not fully configured', () => {
    const c = parseM365Config({ M365_ENABLED: 'true', M365_TENANT_ID: 't' });
    expect(c.enabled).toBe(true);
    expect(c.configured).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-config`
Expected: FAIL — `parseM365Config` is not exported.

- [ ] **Step 3: Implement in `apps/api/src/config.ts`**

Add this type, function, and field. Insert the type + function above the existing `export const config`:

```ts
export type M365Cloud = 'commercial' | 'gcc' | 'gcchigh' | 'azgov';

export interface M365Config {
  /** Master switch. When false, the console (dev) transport is used. */
  enabled: boolean;
  /** True only when enabled AND all credentials + mailbox are present. */
  configured: boolean;
  cloud: M365Cloud;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  serviceMailbox: string;
  ingestEnabled: boolean;
  teamsEnabled: boolean;
}

const bool = (v: string | undefined): boolean => v === 'true' || v === '1';

export function parseM365Config(env: NodeJS.ProcessEnv): M365Config {
  const enabled = bool(env.M365_ENABLED);
  const tenantId = env.M365_TENANT_ID ?? '';
  const clientId = env.M365_CLIENT_ID ?? '';
  const clientSecret = env.M365_CLIENT_SECRET ?? '';
  const serviceMailbox = env.M365_SERVICE_MAILBOX ?? '';
  const configured =
    enabled && !!tenantId && !!clientId && !!clientSecret && !!serviceMailbox;
  return {
    enabled,
    configured,
    cloud: (env.M365_CLOUD as M365Cloud) ?? 'gcc',
    tenantId,
    clientId,
    clientSecret,
    serviceMailbox,
    ingestEnabled: bool(env.M365_INGEST_ENABLED),
    teamsEnabled: bool(env.M365_TEAMS_ENABLED),
  };
}
```

Then add `m365: M365Config;` to the `Config` interface and `m365: parseM365Config(process.env),` to the `config` object literal.

- [ ] **Step 4: Append to `.env.example`**

```bash
# --- Microsoft 365 (GCC) integration ---
# Master switch. When false/absent, notifications use the dev console transport.
M365_ENABLED=false
# Cloud: commercial | gcc | gcchigh | azgov. GCC uses the commercial endpoints.
M365_CLOUD=gcc
# App registration (client-credentials / app-only). Mail.Send application permission.
M365_TENANT_ID=
M365_CLIENT_ID=
M365_CLIENT_SECRET=
# UPN of the enclave service mailbox that sends and receives notifications.
M365_SERVICE_MAILBOX=
# Inbound mail -> ticket polling, and Teams channel posting (off until validated).
M365_INGEST_ENABLED=false
M365_TEAMS_ENABLED=false
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- m365-config && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config.ts apps/api/test/m365-config.test.ts .env.example
git commit -m "feat(m365): add M365 GCC config block + parser"
```

---

## Task 2: OAuth2 token provider

**Files:**
- Create: `apps/api/src/integrations/m365/token.ts`
- Test: `apps/api/test/m365-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-token.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createTokenProvider } from '../src/integrations/m365/token.js';

function okToken(token: string, expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
    text: async () => '',
  };
}

const base = {
  loginAuthority: 'https://login.microsoftonline.com',
  graphEndpoint: 'https://graph.microsoft.com',
  tenantId: 't1',
  clientId: 'c1',
  clientSecret: 's1',
};

describe('createTokenProvider', () => {
  it('fetches once and caches while valid', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => okToken('tok1'));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => now });
    expect(await p.getToken()).toBe('tok1');
    now = 1000;
    expect(await p.getToken()).toBe('tok1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes after expiry', async () => {
    let now = 0;
    let n = 0;
    const fetchImpl = vi.fn(async () => okToken(`tok${++n}`, 3600));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => now });
    expect(await p.getToken()).toBe('tok1');
    now = 3_600_000; // past expiry (minus the 60s safety margin)
    expect(await p.getToken()).toBe('tok2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requests the .default scope for the graph endpoint', async () => {
    const fetchImpl = vi.fn(async () => okToken('tok1'));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => 0 });
    await p.getToken();
    const body = String((fetchImpl.mock.calls[0][1] as any).body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain(encodeURIComponent('https://graph.microsoft.com/.default'));
  });

  it('throws on a non-ok token response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'bad' }));
    const p = createTokenProvider({ ...base, fetchImpl: fetchImpl as any, now: () => 0 });
    await expect(p.getToken()).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-token`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/integrations/m365/token.ts`**

```ts
// OAuth2 client-credentials token provider for Microsoft Graph (app-only).
// Endpoints are injected (sourced from cloud_environments) so the same code
// serves commercial, GCC, and GCC High. Tokens are cached in-memory until
// shortly before expiry.

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface TokenProviderOptions {
  loginAuthority: string; // e.g. https://login.microsoftonline.com
  graphEndpoint: string; // e.g. https://graph.microsoft.com
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: FetchLike;
  now: () => number; // injectable clock (ms epoch)
}

export interface TokenProvider {
  getToken: () => Promise<string>;
}

const SAFETY_MARGIN_MS = 60_000;

export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async getToken(): Promise<string> {
      const now = opts.now();
      if (cached && cached.expiresAt - SAFETY_MARGIN_MS > now) return cached.token;

      const url = `${opts.loginAuthority}/${opts.tenantId}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: `${opts.graphEndpoint}/.default`,
      }).toString();

      const res = await opts.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) {
        throw new Error(`M365 token request failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      cached = { token: data.access_token, expiresAt: now + Number(data.expires_in) * 1000 };
      return cached.token;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- m365-token`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/m365/token.ts apps/api/test/m365-token.test.ts
git commit -m "feat(m365): client-credentials token provider with caching"
```

---

## Task 3: Graph HTTP client (auth + throttling/retry)

**Files:**
- Create: `apps/api/src/integrations/m365/graph-client.ts`
- Test: `apps/api/test/m365-graph-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-graph-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createGraphClient, GraphError } from '../src/integrations/m365/graph-client.js';

function res(status: number, body: any, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const deps = (fetchImpl: any) => ({
  graphEndpoint: 'https://graph.microsoft.com',
  getToken: async () => 'tok',
  fetchImpl,
  sleep: vi.fn(async () => {}),
});

describe('createGraphClient', () => {
  it('GETs v1.0 with a bearer token and returns json', async () => {
    const fetchImpl = vi.fn(async () => res(200, { id: 'u1' }));
    const c = createGraphClient(deps(fetchImpl));
    const out = await c.get('/users/svc@x');
    expect(out).toEqual({ id: 'u1' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/users/svc@x');
    expect((fetchImpl.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok');
  });

  it('retries on 429 honoring Retry-After then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, 'slow down', { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const d = deps(fetchImpl);
    const c = createGraphClient(d);
    const out = await c.get('/me');
    expect(out).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(2000);
  });

  it('returns null for 202/204 (no body)', async () => {
    const fetchImpl = vi.fn(async () => res(202, ''));
    const c = createGraphClient(deps(fetchImpl));
    expect(await c.post('/users/x/sendMail', {})).toBeNull();
  });

  it('throws GraphError on a non-retryable 4xx', async () => {
    const fetchImpl = vi.fn(async () => res(403, { error: 'forbidden' }));
    const c = createGraphClient(deps(fetchImpl));
    await expect(c.get('/x')).rejects.toBeInstanceOf(GraphError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-graph-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/integrations/m365/graph-client.ts`**

```ts
// Microsoft Graph v1.0 HTTP client. Injects the bearer token, prefixes the
// per-cloud base URL, and honors 429/503 + Retry-After with jittered backoff
// (docs/nexus/06 §L.6). Audit logging of call class is done by callers; this
// layer never logs request/response bodies.
import { logger } from '../../logger.js';
import type { FetchLike } from './token.js';

export class GraphError extends Error {
  constructor(public status: number, public body: string) {
    super(`Graph request failed: ${status}`);
    this.name = 'GraphError';
  }
}

type FetchWithHeaders = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface GraphClientOptions {
  graphEndpoint: string;
  getToken: () => Promise<string>;
  fetchImpl: FetchWithHeaders | FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface GraphClient {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createGraphClient(opts: GraphClientOptions): GraphClient {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 4;
  const fetchImpl = opts.fetchImpl as FetchWithHeaders;

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const url = path.startsWith('http') ? path : `${opts.graphEndpoint}/v1.0${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await opts.getToken();
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500, 8000) + Math.floor(attempt * 137); // jittered backoff
        logger.warn({ status: res.status, attempt, waitMs }, 'graph throttled; backing off');
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new GraphError(res.status, await res.text());
      if (res.status === 202 || res.status === 204) return null;
      return res.json();
    }
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- m365-graph-client`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/m365/graph-client.ts apps/api/test/m365-graph-client.test.ts
git commit -m "feat(m365): Graph HTTP client with throttle/retry"
```

---

## Task 4: Adapter interface + console (dev) adapter

**Files:**
- Create: `apps/api/src/integrations/m365/adapter.ts`
- Create: `apps/api/src/integrations/m365/console-adapter.ts`
- Test: `apps/api/test/m365-console-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-console-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createConsoleAdapter } from '../src/integrations/m365/console-adapter.js';

describe('console adapter', () => {
  it('reports email capability and returns sent', async () => {
    const a = createConsoleAdapter();
    expect(a.name).toBe('console');
    expect(a.capabilities().email).toBe(true);
    const r = await a.sendEmail({ to: 'x@y.gov', subject: 'hi', html: '<p>h</p>', text: 'h' });
    expect(r.status).toBe('sent');
    expect(r.providerMessageId).toMatch(/^console:/);
  });

  it('reports teams capability and returns sent', async () => {
    const a = createConsoleAdapter();
    expect(a.capabilities().teams).toBe(true);
    const r = await a.sendTeams({ summary: 'sla breached', text: 'details' });
    expect(r.status).toBe('sent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-console-adapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/integrations/m365/adapter.ts`**

```ts
// Notification adapter contract (docs/nexus/06 §K.5). The router calls this
// interface; the concrete implementation (Graph vs console) is chosen at runtime
// from config + the per-cloud capability matrix.

export interface EmailEnvelope {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
}

export interface TeamsEnvelope {
  summary: string;
  text: string;
}

export interface DeliveryResult {
  status: 'sent' | 'failed';
  providerMessageId?: string;
  error?: string;
}

export interface AdapterCapabilities {
  email: boolean;
  teams: boolean;
}

export interface NotificationAdapter {
  name: string;
  capabilities: () => AdapterCapabilities;
  sendEmail: (env: EmailEnvelope) => Promise<DeliveryResult>;
  sendTeams: (env: TeamsEnvelope) => Promise<DeliveryResult>;
}
```

- [ ] **Step 4: Implement `apps/api/src/integrations/m365/console-adapter.ts`**

```ts
// Dev transport: renders the message to logs instead of calling Graph. Lets the
// entire notification pipeline (resolve -> render -> record) run without M365
// credentials. Selected whenever M365 is disabled or not fully configured.
import { ulid } from 'ulid';
import { logger } from '../../logger.js';
import type { NotificationAdapter } from './adapter.js';

export function createConsoleAdapter(): NotificationAdapter {
  return {
    name: 'console',
    capabilities: () => ({ email: true, teams: true }),
    async sendEmail(env) {
      logger.info({ to: env.to, subject: env.subject }, '[console] email (dev transport)');
      return { status: 'sent', providerMessageId: `console:${ulid()}` };
    },
    async sendTeams(env) {
      logger.info({ summary: env.summary }, '[console] teams (dev transport)');
      return { status: 'sent', providerMessageId: `console:${ulid()}` };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- m365-console-adapter`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/integrations/m365/adapter.ts apps/api/src/integrations/m365/console-adapter.ts apps/api/test/m365-console-adapter.test.ts
git commit -m "feat(m365): notification adapter interface + console dev adapter"
```

---

# TIER 2 — Outbound email

## Task 5: Migration 0005 (tables + delivery columns)

**Files:**
- Create: `apps/api/src/db/migrations/0005_m365_integration.sql`

- [ ] **Step 1: Write the migration**

Create `apps/api/src/db/migrations/0005_m365_integration.sql`:

```sql
-- M365 GCC integration: notification prefs, integration cursors/state, health
-- checks, and richer delivery records (docs/nexus/06 §K, §L).

-- Per-user email opt-out (minimal preference center; quiet hours/digest are future).
CREATE TABLE notification_preferences (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  email_enabled   boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Key/value cursors for integrations (e.g. inbox delta link, processed message ids).
CREATE TABLE integration_state (
  integration text NOT NULL,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration, key)
);

-- Integration health probe results (docs/nexus/06 §L.8).
CREATE TABLE integration_health_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration text NOT NULL,
  check_name  text NOT NULL,
  status      text NOT NULL,           -- pass | fail | skipped
  detail      jsonb NOT NULL DEFAULT '{}',
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_health_integration_time ON integration_health_checks(integration, checked_at DESC);

-- Richer delivery records.
ALTER TABLE notification_deliveries ADD COLUMN provider_message_id text;
ALTER TABLE notification_deliveries ADD COLUMN attempts int NOT NULL DEFAULT 0;

-- RLS for the org-scoped preferences table (consistent with existing policies).
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_isolation ON notification_preferences
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));
```

- [ ] **Step 2: Apply the migration**

Run: `npm run migrate`
Expected: log line `apply 0005_m365_integration.sql` then `migrations complete`.
(If no local Postgres is running, start it with `docker compose up -d db` from the repo root first.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0005_m365_integration.sql
git commit -m "feat(m365): migration for prefs, integration state, health, delivery columns"
```

---

## Task 6: Notification templates

**Files:**
- Create: `apps/api/src/modules/notifications-templates.ts`
- Test: `apps/api/test/notifications-templates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/notifications-templates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/modules/notifications-templates.js';

describe('renderTemplate', () => {
  it('renders an sla.breached email with ticket context', () => {
    const out = renderTemplate('sla.breached', {
      orgName: 'Acme',
      ticketNumber: 'ACME-000123',
      subject: 'Server down',
      metric: 'resolution',
    });
    expect(out.subject).toContain('ACME-000123');
    expect(out.subject.toLowerCase()).toContain('sla');
    expect(out.html).toContain('Server down');
    expect(out.text).toContain('ACME-000123');
  });

  it('falls back to a generic template for unknown events', () => {
    const out = renderTemplate('something.unmapped', { orgName: 'Acme' });
    expect(out.subject).toContain('Acme');
    expect(out.text.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- notifications-templates`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/modules/notifications-templates.ts`**

```ts
// Per-event notification templates (docs/nexus/06 §K.3 template engine).
// A small TS map keeps us dependency-free; tenant branding (org name / from-name)
// is threaded through the context. i18n keys are future work.

export interface TemplateContext {
  orgName?: string;
  ticketNumber?: string;
  subject?: string;
  metric?: string;
  severity?: string;
  [k: string]: unknown;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

function wrap(title: string, lines: string[]): RenderedTemplate {
  const text = [title, '', ...lines].join('\n');
  const html =
    `<h2>${title}</h2>` + lines.map((l) => `<p>${l}</p>`).join('');
  return { subject: title, html, text };
}

type Renderer = (c: TemplateContext) => RenderedTemplate;

const TEMPLATES: Record<string, Renderer> = {
  'ticket.created': (c) =>
    wrap(`[${c.ticketNumber}] New ticket: ${c.subject ?? ''}`, [
      `A new ticket was created for ${c.orgName ?? 'your organization'}.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'ticket.assigned': (c) =>
    wrap(`[${c.ticketNumber}] Ticket assigned`, [
      `Ticket ${c.ticketNumber} was assigned.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'ticket.status_changed': (c) =>
    wrap(`[${c.ticketNumber}] Status changed`, [
      `Ticket ${c.ticketNumber} changed status.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'sla.warning': (c) =>
    wrap(`[${c.ticketNumber}] SLA warning (${c.metric ?? 'sla'})`, [
      `The ${c.metric ?? 'SLA'} target for ticket ${c.ticketNumber} is at risk.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'sla.breached': (c) =>
    wrap(`[${c.ticketNumber}] SLA breached (${c.metric ?? 'sla'})`, [
      `The ${c.metric ?? 'SLA'} target for ticket ${c.ticketNumber} has been breached.`,
      `Subject: ${c.subject ?? ''}`,
    ]),
  'posture.finding_created': (c) =>
    wrap(`New posture finding (${c.severity ?? 'finding'})`, [
      `A new ${c.severity ?? ''} posture finding was created for ${c.orgName ?? 'your organization'}.`,
    ]),
};

export function renderTemplate(eventType: string, ctx: TemplateContext): RenderedTemplate {
  const renderer = TEMPLATES[eventType];
  if (renderer) return renderer(ctx);
  return wrap(`Notification for ${ctx.orgName ?? 'your organization'}`, [
    `Event: ${eventType}`,
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- notifications-templates`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/notifications-templates.ts apps/api/test/notifications-templates.test.ts
git commit -m "feat(m365): per-event notification templates"
```

---

## Task 7: Recipient resolution

**Files:**
- Create: `apps/api/src/modules/notifications-recipients.ts`
- Test: `apps/api/test/notifications-recipients.test.ts`

This module resolves recipients with a single SQL query per event family, filtering opt-outs inline. Tests use a fake `Sql` whose `query` returns a fixed result.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/notifications-recipients.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveRecipients } from '../src/modules/notifications-recipients.js';
import type { DomainEvent } from '../src/events/bus.js';

function fakeSql(rows: any[]) {
  return { query: vi.fn(async () => ({ rows })) } as any;
}
function evt(type: string, data: Record<string, unknown>): DomainEvent {
  return {
    event_id: 'e', type, occurred_at: '', organization_id: 'org-1',
    idempotency_key: 'k', version: 1, data,
  };
}

describe('resolveRecipients', () => {
  it('resolves ticket assignee + requester for sla events and queries tickets', async () => {
    const sql = fakeSql([
      { user_id: 'u1', email: 'agent@x.gov' },
      { user_id: 'u2', email: 'req@y.gov' },
    ]);
    const out = await resolveRecipients(sql, evt('sla.breached', { ticket_id: 't1' }));
    expect(out.map((r) => r.email).sort()).toEqual(['agent@x.gov', 'req@y.gov']);
    expect(sql.query.mock.calls[0][0]).toContain('FROM tickets');
    expect(sql.query.mock.calls[0][1]).toEqual(['t1']);
  });

  it('resolves org admins for posture events', async () => {
    const sql = fakeSql([{ user_id: 'a1', email: 'admin@x.gov' }]);
    const out = await resolveRecipients(sql, evt('posture.finding_created', {}));
    expect(out).toEqual([{ userId: 'a1', email: 'admin@x.gov' }]);
    expect(sql.query.mock.calls[0][0]).toContain('role_assignments');
    expect(sql.query.mock.calls[0][1]).toEqual(['org-1']);
  });

  it('returns empty (no query) for ticket events without a ticket id', async () => {
    const sql = fakeSql([]);
    const out = await resolveRecipients(sql, evt('ticket.created', {}));
    expect(out).toEqual([]);
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('dedupes by user id', async () => {
    const sql = fakeSql([
      { user_id: 'u1', email: 'a@x.gov' },
      { user_id: 'u1', email: 'a@x.gov' },
    ]);
    const out = await resolveRecipients(sql, evt('sla.warning', { ticket_id: 't1' }));
    expect(out).toEqual([{ userId: 'u1', email: 'a@x.gov' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- notifications-recipients`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/modules/notifications-recipients.ts`**

```ts
// Resolve who should be notified for an event, from domain context
// (docs/nexus/06 §K.1). One query per event family; per-user email opt-outs are
// filtered inline via notification_preferences. Runs under the caller's Sql
// context (system context for background dispatch).
import type { Sql } from '../db/pool.js';
import type { DomainEvent } from '../events/bus.js';

export interface Recipient {
  userId: string;
  email: string;
}

// Roles that receive org-wide notifications (posture findings, etc.).
const ADMIN_ROLE_KEYS = ['OrgAdmin', 'SecurityContact'];

// Opt-out filter shared by every query: include a user unless they have explicitly
// disabled email.
const NOT_OPTED_OUT =
  `COALESCE((SELECT np.email_enabled FROM notification_preferences np WHERE np.user_id = u.id), true)`;

function dedupe(rows: { user_id: string; email: string }[]): Recipient[] {
  const seen = new Map<string, Recipient>();
  for (const r of rows) {
    if (r.email && !seen.has(r.user_id)) seen.set(r.user_id, { userId: r.user_id, email: r.email });
  }
  return [...seen.values()];
}

export async function resolveRecipients(sql: Sql, evt: DomainEvent): Promise<Recipient[]> {
  const data = evt.data as Record<string, unknown>;
  const type = evt.type;

  if (type.startsWith('ticket.') || type.startsWith('sla.')) {
    const ticketId = (data.ticket_id ?? data.id ?? data.ticketId) as string | undefined;
    if (!ticketId) return [];
    const { rows } = await sql.query(
      `SELECT u.id AS user_id, u.email
         FROM tickets t
         JOIN users u ON u.id = ANY(ARRAY[t.assigned_agent_id, t.requester_id])
        WHERE t.id = $1 AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
      [ticketId],
    );
    return dedupe(rows);
  }

  if (type.startsWith('posture.')) {
    if (!evt.organization_id) return [];
    const { rows } = await sql.query(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM users u
         JOIN role_assignments ra ON ra.user_id = u.id
         JOIN roles r ON r.id = ra.role_id
        WHERE u.organization_id = $1 AND r.key = ANY($2)
          AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
      [evt.organization_id, ADMIN_ROLE_KEYS],
    );
    return dedupe(rows);
  }

  if (type.startsWith('oncall.')) {
    const scheduleId = (data.schedule_id ?? data.scheduleId) as string | undefined;
    if (!scheduleId) return [];
    const { rows } = await sql.query(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM oncall_participants p
         JOIN oncall_rotations rot ON rot.id = p.rotation_id
         JOIN users u ON u.id = p.user_id
        WHERE rot.schedule_id = $1 AND u.email IS NOT NULL AND ${NOT_OPTED_OUT}`,
      [scheduleId],
    );
    return dedupe(rows);
  }

  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- notifications-recipients`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/notifications-recipients.ts apps/api/test/notifications-recipients.test.ts
git commit -m "feat(m365): resolve notification recipients from domain context"
```

---

## Task 8: Graph email adapter

**Files:**
- Create: `apps/api/src/integrations/m365/graph-adapter.ts`
- Test: `apps/api/test/m365-graph-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-graph-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createGraphAdapter } from '../src/integrations/m365/graph-adapter.js';

describe('graph adapter — email', () => {
  it('posts sendMail to the service mailbox and returns sent', async () => {
    const post = vi.fn(async () => null); // 202 -> null
    const graphClient = { get: vi.fn(), post } as any;
    const a = createGraphAdapter({ graphClient, serviceMailbox: 'svc@agency.gov', teamsEnabled: false });
    const r = await a.sendEmail({ to: 'u@x.gov', subject: 'S', html: '<p>h</p>', text: 'h' });
    expect(r.status).toBe('sent');
    expect(post.mock.calls[0][0]).toBe('/users/svc@agency.gov/sendMail');
    const body = post.mock.calls[0][1] as any;
    expect(body.message.toRecipients[0].emailAddress.address).toBe('u@x.gov');
    expect(body.message.subject).toBe('S');
  });

  it('returns failed when the graph call throws', async () => {
    const graphClient = { get: vi.fn(), post: vi.fn(async () => { throw new Error('boom'); }) } as any;
    const a = createGraphAdapter({ graphClient, serviceMailbox: 'svc@agency.gov', teamsEnabled: false });
    const r = await a.sendEmail({ to: 'u@x.gov', subject: 'S', html: 'h', text: 'h' });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('boom');
  });

  it('reports teams capability from the flag', () => {
    const graphClient = { get: vi.fn(), post: vi.fn() } as any;
    expect(createGraphAdapter({ graphClient, serviceMailbox: 'm', teamsEnabled: false }).capabilities().teams).toBe(false);
    expect(createGraphAdapter({ graphClient, serviceMailbox: 'm', teamsEnabled: true }).capabilities().teams).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-graph-adapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/integrations/m365/graph-adapter.ts`**

```ts
// Real Graph adapter: sends email via Mail.Send from the enclave service mailbox
// (docs/nexus/06 §L.4/§L.7) and posts to Teams where enabled (§L.5). Email is
// always available; Teams is gated by config + per-tenant validation.
import { ulid } from 'ulid';
import { logger } from '../../logger.js';
import type { GraphClient } from './graph-client.js';
import type { NotificationAdapter } from './adapter.js';

export interface GraphAdapterOptions {
  graphClient: GraphClient;
  serviceMailbox: string;
  teamsEnabled: boolean;
  /** Optional Teams target for channel posting (team + channel ids). */
  teamsTarget?: { teamId: string; channelId: string };
}

export function createGraphAdapter(opts: GraphAdapterOptions): NotificationAdapter {
  return {
    name: 'graph',
    capabilities: () => ({ email: true, teams: opts.teamsEnabled && !!opts.teamsTarget }),

    async sendEmail(env) {
      try {
        await opts.graphClient.post(`/users/${opts.serviceMailbox}/sendMail`, {
          message: {
            subject: env.subject,
            body: { contentType: 'HTML', content: env.html },
            toRecipients: [{ emailAddress: { address: env.to } }],
            from: env.fromName
              ? { emailAddress: { address: opts.serviceMailbox, name: env.fromName } }
              : undefined,
          },
          saveToSentItems: true,
        });
        // sendMail returns 202 with no body; correlate with our own id.
        return { status: 'sent', providerMessageId: `graph:${ulid()}` };
      } catch (err) {
        logger.error({ err, to: env.to }, 'graph sendMail failed');
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },

    async sendTeams(env) {
      if (!opts.teamsEnabled || !opts.teamsTarget) {
        return { status: 'failed', error: 'teams not enabled' };
      }
      try {
        const { teamId, channelId } = opts.teamsTarget;
        await opts.graphClient.post(`/teams/${teamId}/channels/${channelId}/messages`, {
          body: { contentType: 'html', content: `<b>${env.summary}</b><br/>${env.text}` },
        });
        return { status: 'sent', providerMessageId: `graph:${ulid()}` };
      } catch (err) {
        logger.error({ err }, 'graph teams post failed');
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- m365-graph-adapter`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/m365/graph-adapter.ts apps/api/test/m365-graph-adapter.test.ts
git commit -m "feat(m365): Graph email + Teams adapter"
```

---

## Task 9: Runtime builder + dispatcher rewrite

**Files:**
- Create: `apps/api/src/integrations/m365/runtime.ts`
- Modify: `apps/api/src/modules/notifications.ts` (full rewrite)
- Test: `apps/api/test/notifications-dispatch.test.ts`

The runtime memoizes the selected adapter (and Graph client) so the dispatcher and jobs share one instance. The dispatcher is rewritten to resolve recipients, render, send, and record per recipient, with the portal floor and channel substitution preserved.

- [ ] **Step 1: Implement `apps/api/src/integrations/m365/runtime.ts`**

```ts
// Lazily builds and memoizes the M365 runtime (token provider, Graph client,
// adapter) from config + the per-cloud endpoints in cloud_environments. When
// M365 is not fully configured, the console (dev) adapter is used.
import { config } from '../../config.js';
import { withSystemContext } from '../../db/pool.js';
import { createTokenProvider } from './token.js';
import { createGraphClient, type GraphClient } from './graph-client.js';
import { createGraphAdapter } from './graph-adapter.js';
import { createConsoleAdapter } from './console-adapter.js';
import type { NotificationAdapter } from './adapter.js';

interface CloudEnv {
  login_authority: string;
  graph_endpoint: string;
}

async function loadCloudEnv(cloud: string): Promise<CloudEnv> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT login_authority, graph_endpoint FROM cloud_environments WHERE cloud = $1',
      [cloud],
    );
    if (!rows[0]) throw new Error(`unknown cloud environment: ${cloud}`);
    return rows[0] as CloudEnv;
  });
}

let adapterPromise: Promise<NotificationAdapter> | null = null;
let graphClientPromise: Promise<GraphClient | null> | null = null;

async function buildGraphClient(): Promise<GraphClient | null> {
  if (!config.m365.configured) return null;
  const env = await loadCloudEnv(config.m365.cloud);
  const tokenProvider = createTokenProvider({
    loginAuthority: env.login_authority,
    graphEndpoint: env.graph_endpoint,
    tenantId: config.m365.tenantId,
    clientId: config.m365.clientId,
    clientSecret: config.m365.clientSecret,
    fetchImpl: fetch as any,
    now: () => Date.now(),
  });
  return createGraphClient({
    graphEndpoint: env.graph_endpoint,
    getToken: tokenProvider.getToken,
    fetchImpl: fetch as any,
  });
}

/** The Graph client, or null when M365 is not configured (used by ingest/health). */
export function getGraphClient(): Promise<GraphClient | null> {
  if (!graphClientPromise) graphClientPromise = buildGraphClient();
  return graphClientPromise;
}

/** The notification adapter — Graph when configured, console otherwise. */
export function getNotificationAdapter(): Promise<NotificationAdapter> {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      const client = await getGraphClient();
      if (!client) return createConsoleAdapter();
      return createGraphAdapter({
        graphClient: client,
        serviceMailbox: config.m365.serviceMailbox,
        teamsEnabled: config.m365.teamsEnabled,
      });
    })();
  }
  return adapterPromise;
}

/** Test seam: drop memoized instances so config/env changes take effect. */
export function __resetM365Runtime(): void {
  adapterPromise = null;
  graphClientPromise = null;
}
```

- [ ] **Step 2: Write the failing dispatcher test**

Create `apps/api/test/notifications-dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../src/modules/notifications.js';
import type { NotificationAdapter } from '../src/integrations/m365/adapter.js';
import type { DomainEvent } from '../src/events/bus.js';

// A fake Sql that answers each query by matching text.
function makeSql(opts: { cloud: string; emailCap: string; teamsCap: string; recipients: any[] }) {
  const inserts: any[] = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    if (text.includes('FROM organizations')) return { rows: [{ cloud: opts.cloud }] };
    if (text.includes('capability_matrix')) {
      return { rows: [{ capability_matrix: { email: opts.emailCap, teams: opts.teamsCap } }] };
    }
    if (text.startsWith('INSERT INTO notification_deliveries')) {
      inserts.push(params);
      return { rows: [] };
    }
    // recipient resolution
    return { rows: opts.recipients };
  });
  return { sql: { query } as any, inserts };
}

function evt(type: string): DomainEvent {
  return {
    event_id: 'e', type, occurred_at: '', organization_id: 'org-1',
    idempotency_key: 'k', version: 1, data: { ticket_id: 't1' },
  };
}

function adapterStub(over: Partial<NotificationAdapter> = {}): NotificationAdapter {
  return {
    name: 'stub',
    capabilities: () => ({ email: true, teams: true }),
    sendEmail: vi.fn(async () => ({ status: 'sent', providerMessageId: 'p1' })),
    sendTeams: vi.fn(async () => ({ status: 'sent', providerMessageId: 'p2' })),
    ...over,
  };
}

describe('dispatch', () => {
  it('sends email per recipient and records the portal floor', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'gcc', emailCap: 'supported', teamsCap: 'requires_validation',
      recipients: [{ user_id: 'u1', email: 'a@x.gov' }, { user_id: 'u2', email: 'b@x.gov' }],
    });
    const adapter = adapterStub();
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    expect(adapter.sendEmail).toHaveBeenCalledTimes(2);
    const channels = inserts.map((p) => p[2]); // channel column
    expect(channels).toContain('portal');
    expect(channels.filter((c) => c === 'email').length).toBe(2);
  });

  it('substitutes to portal when no external channel is supported', async () => {
    const { sql, inserts } = makeSql({
      cloud: 'gcchigh', emailCap: 'requires_validation', teamsCap: 'requires_validation',
      recipients: [{ user_id: 'u1', email: 'a@x.gov' }],
    });
    const adapter = adapterStub();
    await dispatch(sql, 'org-1', evt('sla.breached'), adapter);
    expect(adapter.sendEmail).not.toHaveBeenCalled();
    const portal = inserts.find((p) => p[2] === 'portal');
    expect(portal[4]).toBe('sent'); // status column
    expect(inserts.some((p) => p[5] && String(p[5]).includes('falling back'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- notifications-dispatch`
Expected: FAIL — `dispatch` is not exported (the current module keeps it private).

- [ ] **Step 4: Rewrite `apps/api/src/modules/notifications.ts`**

Replace the entire file with:

```ts
// Notification dispatcher (docs/nexus/06 §K, ADR-006).
// Resolves recipients from domain context, renders per-event templates, and
// sends via the selected adapter (Graph when configured, console otherwise).
// Per-cloud capability matrix drives channel selection with the fallback chain
// Teams -> Email -> Portal; portal is the universal floor and is always recorded.
import { withSystemContext, type Sql } from '../db/pool.js';
import { subscribe, type DomainEvent } from '../events/bus.js';
import { logger } from '../logger.js';
import { resolveRecipients } from './notifications-recipients.js';
import { renderTemplate } from './notifications-templates.js';
import { getNotificationAdapter } from '../integrations/m365/runtime.js';
import type { NotificationAdapter } from '../integrations/m365/adapter.js';

type Channel = 'teams' | 'email' | 'portal';

async function capability(sql: Sql, cloud: string, channel: Channel): Promise<string> {
  const { rows } = await sql.query(
    'SELECT capability_matrix FROM cloud_environments WHERE cloud = $1',
    [cloud],
  );
  const matrix = rows[0]?.capability_matrix ?? {};
  return matrix[channel] ?? 'requires_validation';
}

async function orgCloud(sql: Sql, orgId: string | null): Promise<string> {
  if (!orgId) return 'commercial';
  const { rows } = await sql.query('SELECT cloud FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.cloud ?? 'commercial';
}

async function orgName(sql: Sql, orgId: string | null): Promise<string> {
  if (!orgId) return 'your organization';
  const { rows } = await sql.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.name ?? 'your organization';
}

async function record(
  sql: Sql,
  orgId: string | null,
  eventType: string,
  channel: Channel,
  recipient: string | null,
  status: string,
  substitutionReason?: string | null,
  providerMessageId?: string | null,
): Promise<void> {
  await sql.query(
    `INSERT INTO notification_deliveries
       (organization_id, event_type, channel, recipient, status, substitution_reason, provider_message_id, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [orgId, eventType, channel, recipient, status, substitutionReason ?? null, providerMessageId ?? null],
  );
}

/**
 * Dispatch one event. `sql` and `adapter` are injected so this is unit-testable.
 * Records the portal floor, then attempts the best supported external channel.
 */
export async function dispatch(
  sql: Sql,
  orgId: string | null,
  evt: DomainEvent,
  adapter: NotificationAdapter,
): Promise<void> {
  const cloud = await orgCloud(sql, orgId);
  const recipients = await resolveRecipients(sql, evt);

  // Portal floor: always recorded (universal in-app channel, docs/nexus/06 §K.1).
  await record(sql, orgId, evt.type, 'portal', null, 'sent');

  const tpl = renderTemplate(evt.type, {
    orgName: await orgName(sql, orgId),
    ticketNumber: (evt.data as any).ticket_number,
    subject: (evt.data as any).subject,
    metric: (evt.data as any).metric,
    severity: (evt.data as any).severity,
  });

  for (const channel of ['teams', 'email'] as Channel[]) {
    const cap = await capability(sql, cloud, channel);
    const adapterCan = channel === 'email' ? adapter.capabilities().email : adapter.capabilities().teams;
    if (cap !== 'supported' || !adapterCan) {
      const why = cap !== 'supported' ? `${cap} in ${cloud}` : 'adapter unavailable';
      await record(sql, orgId, evt.type, channel, null, 'substituted', `${channel} ${why}; falling back`);
      continue;
    }
    if (recipients.length === 0) {
      await record(sql, orgId, evt.type, channel, null, 'skipped', 'no recipients');
      return; // channel is available; nobody to notify beyond the portal floor
    }
    let anySent = false;
    for (const r of recipients) {
      const result =
        channel === 'email'
          ? await adapter.sendEmail({ to: r.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
          : await adapter.sendTeams({ summary: tpl.subject, text: tpl.text });
      await record(sql, orgId, evt.type, channel, r.email, result.status, result.error ?? null, result.providerMessageId);
      if (result.status === 'sent') anySent = true;
    }
    if (anySent) return; // delivered on this channel; stop the chain
    // all sends failed -> fall through to the next channel
  }
}

/** Wire the dispatcher to events that should notify someone. */
export function registerNotificationHandlers(): void {
  const notifying = [
    'ticket.created',
    'ticket.assigned',
    'ticket.status_changed',
    'sla.warning',
    'sla.breached',
    'posture.finding_created',
    'oncall.acknowledgement_required',
  ];
  for (const type of notifying) {
    subscribe(type, async (evt: DomainEvent) => {
      try {
        const adapter = await getNotificationAdapter();
        await withSystemContext((sql) => dispatch(sql, evt.organization_id, evt, adapter));
      } catch (err) {
        logger.error({ err, type }, 'notification dispatch failed (would DLQ)');
      }
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- notifications-dispatch && npm run typecheck`
Expected: PASS (2 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/integrations/m365/runtime.ts apps/api/src/modules/notifications.ts apps/api/test/notifications-dispatch.test.ts
git commit -m "feat(m365): real dispatcher (recipients + render + send + record)"
```

---

# TIER 3 — Inbound ingestion

## Task 10: Mail ingestion (delta fetch + message→ticket)

**Files:**
- Create: `apps/api/src/integrations/m365/ingest.ts`
- Test: `apps/api/test/m365-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-ingest.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchNewMessages, ingestMessage } from '../src/integrations/m365/ingest.js';

function makeSql(handlers: Record<string, any>) {
  const calls: any[] = [];
  const query = vi.fn(async (text: string, params?: any[]) => {
    calls.push({ text, params });
    for (const key of Object.keys(handlers)) {
      if (text.includes(key)) return handlers[key];
    }
    return { rows: [] };
  });
  return { sql: { query } as any, calls };
}

const msg = {
  id: 'm1',
  internetMessageId: '<abc@x>',
  fromAddress: 'sender@acme.gov',
  subject: 'Help please',
  bodyPreview: 'My laptop is broken',
};

describe('ingest', () => {
  it('creates a ticket when the sender domain maps to an org', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [] }, // not seen before
      'FROM organization_domains': { rows: [{ organization_id: 'org-acme' }] },
      'SELECT COALESCE(MAX': { rows: [{ n: 5 }] },
      'left(upper(name)': { rows: [{ p: 'ACME' }] },
      'INSERT INTO tickets': { rows: [{ id: 't-new' }] },
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(true);
  });

  it('skips and reports when the domain is unmatched', async () => {
    const { sql } = makeSql({
      'FROM integration_state': { rows: [] },
      'FROM organization_domains': { rows: [] },
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('unmatched-domain');
  });

  it('skips a message already processed (dedupe)', async () => {
    const { sql, calls } = makeSql({
      'FROM integration_state': { rows: [{ value: true }] }, // seen
    });
    const out = await ingestMessage(sql, msg);
    expect(out.created).toBe(false);
    expect(out.reason).toBe('duplicate');
    expect(calls.some((c) => c.text.includes('INSERT INTO tickets'))).toBe(false);
  });

  it('fetchNewMessages reads the delta page and stores the deltaLink', async () => {
    const graphClient = {
      get: vi.fn(async () => ({
        value: [
          { id: 'm1', internetMessageId: '<a@x>', subject: 'S', bodyPreview: 'b',
            from: { emailAddress: { address: 'p@acme.gov' } } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=NEXT',
      })),
      post: vi.fn(),
    } as any;
    const { sql } = makeSql({ 'FROM integration_state': { rows: [] } });
    const out = await fetchNewMessages(sql, graphClient, 'svc@agency.gov');
    expect(out).toHaveLength(1);
    expect(out[0].fromAddress).toBe('p@acme.gov');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-ingest`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/integrations/m365/ingest.ts`**

```ts
// Inbound mail -> ticket ingestion (docs/nexus/06 §L.4). Polls the service
// mailbox inbox via Graph delta queries (subscription-ready: a webhook can call
// the same ingestMessage). Sender domain maps to an org via organization_domains;
// unmatched senders are skipped. Dedupe + delta cursor live in integration_state.
import { logger } from '../../logger.js';
import type { Sql } from '../../db/pool.js';
import type { GraphClient } from './graph-client.js';

const INTEGRATION = 'm365';
const DELTA_KEY = 'inbox_delta';

export interface InboundMessage {
  id: string;
  internetMessageId: string;
  fromAddress: string;
  subject: string;
  bodyPreview: string;
}

async function getState(sql: Sql, key: string): Promise<any | null> {
  const { rows } = await sql.query(
    'SELECT value FROM integration_state WHERE integration = $1 AND key = $2',
    [INTEGRATION, key],
  );
  return rows[0]?.value ?? null;
}

async function setState(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql.query(
    `INSERT INTO integration_state (integration, key, value, updated_at)
       VALUES ($1,$2,$3, now())
     ON CONFLICT (integration, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [INTEGRATION, key, JSON.stringify(value)],
  );
}

/** Poll the inbox delta; returns normalized new messages and stores the next deltaLink. */
export async function fetchNewMessages(
  sql: Sql,
  graphClient: GraphClient,
  mailbox: string,
): Promise<InboundMessage[]> {
  const stored = await getState(sql, DELTA_KEY);
  let url: string =
    stored?.deltaLink ??
    `/users/${mailbox}/mailFolders/inbox/messages/delta?$select=id,internetMessageId,subject,bodyPreview,from`;

  const messages: InboundMessage[] = [];
  // Follow nextLink pages until we reach the deltaLink.
  for (;;) {
    const page = await graphClient.get(url);
    for (const m of page.value ?? []) {
      messages.push({
        id: m.id,
        internetMessageId: m.internetMessageId ?? m.id,
        fromAddress: m.from?.emailAddress?.address ?? '',
        subject: m.subject ?? '(no subject)',
        bodyPreview: m.bodyPreview ?? '',
      });
    }
    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    if (page['@odata.deltaLink']) await setState(sql, DELTA_KEY, { deltaLink: page['@odata.deltaLink'] });
    break;
  }
  return messages;
}

/** Create a ticket from one message. Idempotent by internetMessageId. */
export async function ingestMessage(
  sql: Sql,
  msg: InboundMessage,
): Promise<{ created: boolean; reason?: string; ticketId?: string }> {
  const seenKey = `seen:${msg.internetMessageId}`;
  if (await getState(sql, seenKey)) return { created: false, reason: 'duplicate' };

  const domain = msg.fromAddress.split('@')[1]?.toLowerCase() ?? '';
  const { rows: orgRows } = await sql.query(
    'SELECT organization_id FROM organization_domains WHERE domain = $1',
    [domain],
  );
  const orgId = orgRows[0]?.organization_id as string | undefined;
  if (!orgId) {
    logger.warn({ from: msg.fromAddress }, 'inbound mail: unmatched sender domain; skipping');
    await setState(sql, seenKey, true); // do not reprocess unmatched mail
    return { created: false, reason: 'unmatched-domain' };
  }

  // Generate a ticket number (mirrors modules/tickets.ts nextTicketNumber).
  const { rows: nRows } = await sql.query(
    `SELECT COALESCE(MAX((regexp_replace(ticket_number, '\\D','','g'))::int), 0) + 1 AS n
       FROM tickets WHERE organization_id = $1`,
    [orgId],
  );
  const { rows: pRows } = await sql.query(
    'SELECT left(upper(name),4) AS p FROM organizations WHERE id=$1',
    [orgId],
  );
  const ticketNumber = `${pRows[0].p}-${String(nRows[0].n).padStart(6, '0')}`;

  const { rows: tRows } = await sql.query(
    `INSERT INTO tickets
       (organization_id, ticket_number, type, source_channel, subject, description, status)
     VALUES ($1,$2,'incident','email',$3,$4,'new')
     RETURNING id`,
    [orgId, ticketNumber, msg.subject, msg.bodyPreview],
  );

  await setState(sql, seenKey, true);
  logger.info({ ticketId: tRows[0].id, from: msg.fromAddress }, 'inbound mail -> ticket created');
  return { created: true, ticketId: tRows[0].id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- m365-ingest`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/m365/ingest.ts apps/api/test/m365-ingest.test.ts
git commit -m "feat(m365): inbound mail ingestion (delta fetch + message->ticket)"
```

---

## Task 11: Mail-ingest scheduler + server wiring

**Files:**
- Create: `apps/api/src/jobs/mail-ingest.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Implement `apps/api/src/jobs/mail-ingest.ts`**

```ts
// Periodic inbound-mail poll (docs/nexus/06 §L.4/§L.6). No-ops unless M365 is
// configured and ingestion is enabled. Mirrors the sla-sweeper scheduler shape.
import { config } from '../config.js';
import { withSystemContext } from '../db/pool.js';
import { getGraphClient } from '../integrations/m365/runtime.js';
import { fetchNewMessages, ingestMessage } from '../integrations/m365/ingest.js';
import { logger } from '../logger.js';

export function startMailIngest(intervalMs = 60_000): NodeJS.Timeout | null {
  if (!config.m365.configured || !config.m365.ingestEnabled) {
    logger.info('mail ingest disabled (M365 not configured or ingest off)');
    return null;
  }
  const tick = async () => {
    try {
      const client = await getGraphClient();
      if (!client) return;
      await withSystemContext(async (sql) => {
        const messages = await fetchNewMessages(sql, client, config.m365.serviceMailbox);
        for (const m of messages) await ingestMessage(sql, m);
        if (messages.length) logger.info({ count: messages.length }, 'inbound mail processed');
      });
    } catch (err) {
      logger.error({ err }, 'mail ingest tick failed');
    }
  };
  setTimeout(tick, 10_000); // first run shortly after boot
  return setInterval(tick, intervalMs);
}
```

- [ ] **Step 2: Wire into `apps/api/src/server.ts`**

Add the import alongside the other job imports (after the `startConMonScheduler` import):

```ts
import { startMailIngest } from './jobs/mail-ingest.js';
```

Add the start call after `startConMonScheduler();`:

```ts
  // Inbound M365 mail -> ticket polling (no-op unless configured + enabled).
  startMailIngest();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/mail-ingest.ts apps/api/src/server.ts
git commit -m "feat(m365): mail-ingest scheduler wired into server"
```

---

# TIER 4 — Health & test endpoints

## Task 12: Health probes + integrations service

**Files:**
- Create: `apps/api/src/integrations/m365/health.ts`
- Create: `apps/api/src/modules/integrations.ts`
- Test: `apps/api/test/m365-health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/m365-health.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { probe } from '../src/integrations/m365/health.js';

describe('m365 health probe', () => {
  it('reports skipped when no graph client (not configured)', async () => {
    const checks = await probe(null, 'svc@x.gov');
    expect(checks.every((c) => c.status === 'skipped')).toBe(true);
  });

  it('passes mailbox + token checks when graph read succeeds', async () => {
    const graphClient = { get: vi.fn(async () => ({ id: 'u1', mail: 'svc@x.gov' })), post: vi.fn() } as any;
    const checks = await probe(graphClient, 'svc@x.gov');
    const mailbox = checks.find((c) => c.check_name === 'mailbox');
    expect(mailbox?.status).toBe('pass');
  });

  it('fails mailbox check when graph read throws', async () => {
    const graphClient = { get: vi.fn(async () => { throw new Error('403'); }), post: vi.fn() } as any;
    const checks = await probe(graphClient, 'svc@x.gov');
    const mailbox = checks.find((c) => c.check_name === 'mailbox');
    expect(mailbox?.status).toBe('fail');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- m365-health`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/integrations/m365/health.ts`**

```ts
// Side-effect-safe integration probes (docs/nexus/06 §L.8). Each probe is a
// read-only Graph call; results feed integration_health_checks and the test button.
import type { GraphClient } from './graph-client.js';

export interface HealthCheck {
  check_name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: Record<string, unknown>;
}

/** Run read-only probes against the mailbox. `graphClient` is null when unconfigured. */
export async function probe(
  graphClient: GraphClient | null,
  mailbox: string,
): Promise<HealthCheck[]> {
  if (!graphClient) {
    return [
      { check_name: 'token', status: 'skipped', detail: { reason: 'M365 not configured' } },
      { check_name: 'mailbox', status: 'skipped', detail: { reason: 'M365 not configured' } },
    ];
  }
  const checks: HealthCheck[] = [];
  try {
    const user = await graphClient.get(`/users/${mailbox}?$select=id,mail,userPrincipalName`);
    checks.push({ check_name: 'token', status: 'pass', detail: {} });
    checks.push({ check_name: 'mailbox', status: 'pass', detail: { id: user?.id ?? null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({ check_name: 'token', status: 'fail', detail: { error: message } });
    checks.push({ check_name: 'mailbox', status: 'fail', detail: { error: message } });
  }
  return checks;
}
```

- [ ] **Step 4: Implement `apps/api/src/modules/integrations.ts`**

```ts
// Integration health + test service backing the /integrations routes
// (docs/nexus/06 §L.8). Persists probe results and runs the live test button.
import { config } from '../config.js';
import { withSystemContext } from '../db/pool.js';
import { getGraphClient, getNotificationAdapter } from '../integrations/m365/runtime.js';
import { probe, type HealthCheck } from '../integrations/m365/health.js';
import { logger } from '../logger.js';

export interface M365HealthReport {
  configured: boolean;
  cloud: string;
  checks: HealthCheck[];
  capabilities: Record<string, unknown>;
}

async function loadCapabilities(cloud: string): Promise<Record<string, unknown>> {
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT capability_matrix FROM cloud_environments WHERE cloud = $1',
      [cloud],
    );
    return rows[0]?.capability_matrix ?? {};
  });
}

export async function getHealth(): Promise<M365HealthReport> {
  const client = await getGraphClient();
  const checks = await probe(client, config.m365.serviceMailbox);
  await withSystemContext(async (sql) => {
    for (const c of checks) {
      await sql.query(
        `INSERT INTO integration_health_checks (integration, check_name, status, detail)
         VALUES ('m365', $1, $2, $3)`,
        [c.check_name, c.status, JSON.stringify(c.detail)],
      );
    }
  });
  return {
    configured: config.m365.configured,
    cloud: config.m365.cloud,
    checks,
    capabilities: await loadCapabilities(config.m365.cloud),
  };
}

export interface TestResult {
  configured: boolean;
  cloud: string;
  probes: HealthCheck[];
  testEmail?: { status: string; error?: string };
}

/** Live, side-effect-safe test. Optionally sends a single test email. */
export async function runTest(opts: { sendTo?: string }): Promise<TestResult> {
  const client = await getGraphClient();
  const probes = await probe(client, config.m365.serviceMailbox);
  const result: TestResult = { configured: config.m365.configured, cloud: config.m365.cloud, probes };

  if (opts.sendTo) {
    const adapter = await getNotificationAdapter();
    const sent = await adapter.sendEmail({
      to: opts.sendTo,
      subject: 'NexusCyber M365 integration test',
      html: '<p>This is a NexusCyber integration test message.</p>',
      text: 'This is a NexusCyber integration test message.',
    });
    result.testEmail = { status: sent.status, error: sent.error };
    logger.info({ to: opts.sendTo, status: sent.status }, 'm365 integration test email');
  }
  return result;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- m365-health && npm run typecheck`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/integrations/m365/health.ts apps/api/src/modules/integrations.ts apps/api/test/m365-health.test.ts
git commit -m "feat(m365): integration health probes + test service"
```

---

## Task 13: Health + test routes

**Files:**
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Add the import**

In `apps/api/src/http/routes.ts`, add to the module imports (after `import * as automation`):

```ts
import * as integrations from '../modules/integrations.js';
```

- [ ] **Step 2: Add the routes**

Insert before the final closing `}` of `registerRoutes` (after the audit-logs route block):

```ts
  // ---------------- Integrations (M365 GCC) ----------------
  app.get('/api/v1/integrations/m365/health', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'integration.manage'); // nexus platform admins (admin.superuser holds it)
    return integrations.getHealth();
  });

  app.post('/api/v1/integrations/m365/test', async (req) => {
    const p = await requirePrincipal(req);
    authorize(p, 'integration.manage');
    const body = z.object({ sendTo: z.string().email().optional() }).parse(req.body ?? {});
    return integrations.runTest({ sendTo: body.sendTo });
  });
```

(`integration.manage` is not granted to any seeded role, so only `admin.superuser` holders pass `hasVerb` — the intended nexus-admin gate. Grant it explicitly to a platform-admin role later if needed.)

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(m365): health + test integration routes"
```

---

## Task 14: Manual smoke test (console transport) + README note

**Files:**
- Modify: `README.md` (add an M365 section)

- [ ] **Step 1: Smoke-test the dev transport**

Ensure Postgres is up and migrated, then start the API:

Run (from `apps/api/`): `npm run dev`
Expected log includes: `mail ingest disabled (M365 not configured or ingest off)` and the API listening line.

- [ ] **Step 2: Hit the health endpoint**

With a dev nexus-admin session cookie (use `POST /api/v1/auth/dev-login` with a seeded nexus superuser email, then reuse the cookie). Example:

```bash
# returns checks=[token:skipped, mailbox:skipped] and capabilities for gcc
curl -s -b cookies.txt http://localhost:4000/api/v1/integrations/m365/health | jq .
```

Expected: `configured: false`, two `skipped` checks, and the `gcc` capability matrix.

- [ ] **Step 3: Trigger a notification through the console transport**

Create a ticket (which publishes `ticket.created`) and confirm a `[console] email (dev transport)` log line appears, plus a `notification_deliveries` row with channel `portal` (and `email` substituted/sent depending on the seeded `gcc` matrix).

```bash
curl -s -b cookies.txt -X POST http://localhost:4000/api/v1/tickets \
  -H 'Content-Type: application/json' \
  -d '{"subject":"M365 smoke test","description":"hello"}' | jq .
```

- [ ] **Step 4: Add a README section**

Add under the existing setup docs in `README.md`:

```markdown
## Microsoft 365 (GCC) notifications

The API integrates with M365 (GCC by default) for email notifications and inbound
mail-to-ticket. With no credentials, a **console dev transport** logs messages instead
of sending — the full pipeline still runs. To go live, set the `M365_*` vars in `.env`
(see `.env.example`): an app registration with the **Mail.Send** (and, for ingestion,
**Mail.Read**) application permissions, admin-consented, plus the service mailbox UPN.
Verify with `GET /api/v1/integrations/m365/health` and `POST /api/v1/integrations/m365/test`
(`{"sendTo":"you@agency.gov"}`). GCC uses the commercial Graph endpoints; GCC High/DoD
use the `.us` endpoints (already seeded in `cloud_environments`).
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(m365): README notes for GCC notifications + dev transport"
```

---

## Final verification

- [ ] Run the full suite: `cd apps/api && npm run typecheck && npm test` — all green.
- [ ] Confirm the four tiers are independently shippable: Tier 2 alone gives real outbound email; Tier 3 adds inbound; Tier 4 adds health/test.
- [ ] Confirm no secrets are committed (`.env` is gitignored; only `.env.example` placeholders added).

---

## Spec coverage map

| Spec section | Task(s) |
|--------------|---------|
| §1 Config & auth foundation | 1, 2, 3 |
| §2 Outbound email | 4, 6, 7, 8, 9 |
| §3 Inbound ingestion | 10, 11 |
| §4 Teams / health / test | 8 (teams), 12, 13 |
| §5 Migration, deps, testing | 5; tests in every task |
| Endpoints-as-data principle | 9 (runtime reads `cloud_environments`) |
| Portal floor + substitution | 9 (dispatch) |
| Dev transport | 4 (console adapter), 9, 14 |
