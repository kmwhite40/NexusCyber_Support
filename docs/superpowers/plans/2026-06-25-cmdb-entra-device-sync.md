# CMDB Entra/Intune Device Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-populate the CMDB by syncing each customer's Microsoft Entra/Intune managed devices into `device` configuration items, enriched with Intune compliance state, using a per-customer app registration whose secret is stored with app-layer envelope encryption.

**Architecture:** A scheduled per-org job decrypts that org's stored app-registration secret, builds a per-org Microsoft Graph client (reusing the existing `token.ts`/`graph-client.ts`), enumerates `/deviceManagement/managedDevices`, and upserts each device as a `source='entra'` CI keyed by `azureADDeviceId`. Devices that disappear are retired (never deleted), and retirement only runs after a fully successful enumeration. Per-customer credentials live in a new `org_integrations` table; an admin module + routes + web page manage them.

**Tech Stack:** TypeScript, Fastify, PostgreSQL (raw `pg` + RLS), Node `node:crypto` (AES-256-GCM), Vitest. Web: Next.js (App Router) in `apps/web`.

**Reference spec:** `docs/superpowers/specs/2026-06-25-cmdb-entra-device-sync-design.md`

---

## Drift check — 2026-09-02

Re-validated before execution, two months after it was written. **Still cleanly applicable:**
nothing this plan builds has been built since — no `org_integrations`, no
`integration_sync_runs`, none of the `configuration_items` provenance columns. `0051_anchor_integration`
turned out to be API keys and outbound webhooks, with no overlap on per-customer Entra credentials.
The conventions below (ESM `.js` imports, `withSystemContext`/`withOrgContext`, `authorize`/`audit`/
`Errors`, port 5544) all still hold.

**One correction applied:** the migration numbers. See the Conventions note.

**One thing to settle BEFORE executing**, learned the hard way on the offboarding phases: run
`scripts/probe-tenant-followups.sh` first. Its probe 3 answers whether
`/deviceManagement/managedDevices` is reachable in this tenant and whether any devices are
actually enrolled. If nothing is enrolled, this entire plan populates an empty CMDB and the
phase-3 asset-return checklist it exists to feed would be empty for every departure. That is a
cheap question to answer and an expensive one to discover afterwards.

## Conventions (read before starting)

- All API code lives in `apps/api/src`. **ESM imports MUST use the `.js` extension** (e.g. `import { config } from '../config.js'`), even for `.ts` source — this repo compiles ESM.
- DB access: `withSystemContext(async (sql) => …)` for cross-org/background work (bypasses RLS like the mail-ingest job); `withOrgContext(orgContextFor(actor), …)` for actor-scoped work. Both come from `apps/api/src/db/pool.js`.
- AuthZ in modules: `authorize(actor, 'permission.key', { organizationId })` (from `apps/api/src/auth/*`, already imported in `modules/services.ts` — copy its import lines).
- Audit: `audit(actor, { action, organizationId, resourceType, resourceId, detail })`.
- Errors: `Errors.badRequest(msg)`, `Errors.notFound(msg)`.
- Tests live in `apps/api/test/*.test.ts` and import source via `../src/...js`. Run with `npm test` (Vitest) from `apps/api`.
- Migrations: sequential SQL files in `apps/api/src/db/migrations/`. **The next free number is `0070`** — this plan was written in June when it was `0049`, and the tree has since reached `0069`. Creating `0049` now would sort BEFORE two dozen migrations it depends on nothing of, and would never run on any existing database (they are all past it). Run with `npm run migrate` from `apps/api` (needs `--env-file ../../.env` in dev — the dev DB is on host port 5544).
- Routes: register inside the route-builder in `apps/api/src/http/routes.ts`. Each handler does `const p = await requirePrincipal(req);` then validates `req.body`/`req.params` with `zod`.

---

## File Structure

**Create:**
- `apps/api/src/db/migrations/0070_org_integrations.sql` — `org_integrations`, `integration_sync_runs`, `configuration_items` columns, RLS, grants.
- `apps/api/src/integrations/entra/crypto.ts` — AES-256-GCM envelope seal/open (pure).
- `apps/api/src/integrations/entra/device-map.ts` — `mapManagedDevice`, `planRetirements` (pure).
- `apps/api/src/integrations/entra/graph.ts` — per-org Graph client factory + `enumerateManagedDevices`.
- `apps/api/src/integrations/entra/sync.ts` — `applyDeviceSync`, `syncOrg`, `runEnabledIntegrations`.
- `apps/api/src/modules/entra-integrations.ts` — admin module (configure/status/test/enable/trigger).
- `apps/api/src/jobs/entra-sync.ts` — scheduler.
- `apps/api/test/entra-crypto.test.ts`, `apps/api/test/entra-device-map.test.ts`, `apps/api/test/entra-graph.test.ts`, `apps/api/test/entra-sync.test.ts`.
- `apps/web/app/(app)/integrations/page.tsx` — admin UI.

**Modify:**
- `apps/api/src/config.ts` — `INTEGRATION_ENC_KEY` + `entraSync` settings.
- `apps/api/src/db/seed.ts` — `integrations.manage` permission + role grants.
- `apps/api/src/http/routes.ts` — Entra integration routes.
- `apps/api/src/server.ts` — start the scheduler.

---

## Task 1: Migration — schema for credentials, sync runs, and CI provenance

**Files:**
- Create: `apps/api/src/db/migrations/0070_org_integrations.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Per-customer external-integration credentials (Entra/Intune device sync) plus
-- CMDB provenance + sync-run history. Secrets are envelope-encrypted at the app
-- layer (Key Vault is blocked by enclave policy); the DB only ever holds ciphertext.

CREATE TABLE IF NOT EXISTS org_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          text NOT NULL,                        -- 'entra_graph'
  tenant_id         text NOT NULL,
  client_id         text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_iv         bytea NOT NULL,
  secret_tag        bytea NOT NULL,
  key_version       int  NOT NULL DEFAULT 1,
  enabled           boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'unconfigured', -- unconfigured | ok | error
  last_sync_at      timestamptz,
  last_error        text,
  last_sync_stats   jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  created_count   int NOT NULL DEFAULT 0,
  updated_count   int NOT NULL DEFAULT 0,
  retired_count   int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'ok',             -- ok | error
  error           text
);
CREATE INDEX IF NOT EXISTS ix_sync_runs_org ON integration_sync_runs(organization_id, started_at DESC);

-- CMDB provenance: synced devices are source='entra'; manual CIs are never touched
-- by the sync. external_id holds the Entra azureADDeviceId for idempotent upsert.
ALTER TABLE configuration_items
  ADD COLUMN IF NOT EXISTS source      text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ci_source_external
  ON configuration_items(organization_id, source, external_id)
  WHERE external_id IS NOT NULL;

-- Tenant isolation, consistent with every other org-scoped table.
ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_integrations_isolation ON org_integrations;
CREATE POLICY org_integrations_isolation ON org_integrations
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

ALTER TABLE integration_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_sync_runs_isolation ON integration_sync_runs;
CREATE POLICY integration_sync_runs_isolation ON integration_sync_runs
  USING (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id))
  WITH CHECK (organization_id = app_org_id() OR app_is_nexus_in_scope(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON org_integrations TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_sync_runs TO nexus_app;
```

- [ ] **Step 2: Run the migration**

Run: `cd apps/api && npm run migrate -- --env-file ../../.env`
Expected: applies `0070_org_integrations` with no error; re-running is a no-op (idempotent `IF NOT EXISTS`).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/migrations/0070_org_integrations.sql
git commit -m "feat(db): org_integrations, sync-run history, CI provenance columns"
```

---

## Task 2: Permission + role grant

**Files:**
- Modify: `apps/api/src/db/seed.ts`

- [ ] **Step 1: Add the permission**

In `apps/api/src/db/seed.ts`, in the permissions array (the one containing `['admin.users.manage', 'platform_admin']`), add a new entry directly after it:

```ts
  ['admin.users.manage', 'platform_admin'],
  ['integrations.manage', 'platform_admin'],
```

- [ ] **Step 2: Grant it to admin roles**

Still in `seed.ts`, find the `ROLES` map. For **every** role whose `perms` array already includes `'admin.users.manage'`, add `'integrations.manage'` to that same `perms` array. (Confirm which roles those are with: `grep -n "admin.users.manage" apps/api/src/db/seed.ts`.)

- [ ] **Step 3: Re-seed**

Run: `cd apps/api && npm run seed -- --env-file ../../.env`
Expected: completes with no error; the new permission and grants are applied (seed is idempotent/upsert).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/seed.ts
git commit -m "feat(authz): integrations.manage permission for Entra integration admin"
```

---

## Task 3: Config — encryption key + sync settings

**Files:**
- Modify: `apps/api/src/config.ts`

- [ ] **Step 1: Add fields to the exported config object**

In `apps/api/src/config.ts`, locate where the top-level `config` object is assembled (where `m365: parseM365Config(env)` is set). Add these two properties alongside it:

```ts
  integrationEncKey: process.env.INTEGRATION_ENC_KEY ?? '',
  entraSync: {
    enabled: (process.env.ENTRA_SYNC_ENABLED ?? '').toLowerCase() === 'true',
    intervalMs: Number(process.env.ENTRA_SYNC_INTERVAL_MS ?? 6 * 60 * 60 * 1000), // default 6h
  },
```

(If `config` is built via a typed interface, add matching fields: `integrationEncKey: string;` and `entraSync: { enabled: boolean; intervalMs: number };`.)

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/api && npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/config.ts
git commit -m "feat(config): INTEGRATION_ENC_KEY + entraSync interval settings"
```

---

## Task 4: Envelope encryption module (TDD)

**Files:**
- Create: `apps/api/src/integrations/entra/crypto.ts`
- Test: `apps/api/test/entra-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, loadMasterKey } from '../src/integrations/entra/crypto.js';
import { randomBytes } from 'node:crypto';

const KEY_B64 = randomBytes(32).toString('base64');

describe('entra envelope crypto', () => {
  it('round-trips a secret', () => {
    const key = loadMasterKey(KEY_B64);
    const sealed = sealSecret('s3cr3t-value', key);
    expect(sealed.ciphertext).toBeInstanceOf(Buffer);
    expect(openSecret(sealed, key)).toBe('s3cr3t-value');
  });

  it('fails to open with the wrong key', () => {
    const sealed = sealSecret('abc', loadMasterKey(KEY_B64));
    const wrong = loadMasterKey(randomBytes(32).toString('base64'));
    expect(() => openSecret(sealed, wrong)).toThrow();
  });

  it('fails to open if the auth tag is tampered', () => {
    const key = loadMasterKey(KEY_B64);
    const sealed = sealSecret('abc', key);
    sealed.tag[0] ^= 0xff;
    expect(() => openSecret(sealed, key)).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => loadMasterKey(randomBytes(16).toString('base64'))).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npm test -- entra-crypto`
Expected: FAIL — cannot find module `crypto.js` / functions undefined.

- [ ] **Step 3: Implement the module**

```ts
// AES-256-GCM envelope encryption for per-customer integration secrets.
// Key Vault is blocked by enclave policy, so the 32-byte master key is supplied
// via App Service config (INTEGRATION_ENC_KEY, base64). Only ciphertext + iv +
// tag are persisted; decryption happens only at sync/test time.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function loadMasterKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('INTEGRATION_ENC_KEY must decode to 32 bytes');
  return key;
}

export function sealSecret(plaintext: string, key: Buffer, keyVersion = 1): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion };
}

export function openSecret(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npm test -- entra-crypto`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/entra/crypto.ts apps/api/test/entra-crypto.test.ts
git commit -m "feat(entra): AES-256-GCM envelope encryption for integration secrets"
```

---

## Task 5: Device mapper + retirement planner (TDD)

**Files:**
- Create: `apps/api/src/integrations/entra/device-map.ts`
- Test: `apps/api/test/entra-device-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mapManagedDevice, planRetirements } from '../src/integrations/entra/device-map.js';

describe('mapManagedDevice', () => {
  it('maps an Intune managed device to CI fields', () => {
    const m = mapManagedDevice({
      azureADDeviceId: 'aad-1', id: 'intune-1', deviceName: 'LAPTOP-1',
      userPrincipalName: 'jane@contoso.us', operatingSystem: 'Windows',
      osVersion: '10.0.22631', complianceState: 'compliant', isEncrypted: true,
      lastSyncDateTime: '2026-06-25T00:00:00Z', manufacturer: 'Dell',
      model: 'Latitude', serialNumber: 'SN1', managedDeviceOwnerType: 'company',
    });
    expect(m).not.toBeNull();
    expect(m!.externalId).toBe('aad-1');
    expect(m!.name).toBe('LAPTOP-1');
    expect(m!.owner).toBe('jane@contoso.us');
    expect(m!.attributes.complianceState).toBe('compliant');
    expect(m!.attributes.managedDeviceId).toBe('intune-1');
  });

  it('falls back to intune id when azureADDeviceId is the zero GUID', () => {
    const m = mapManagedDevice({ azureADDeviceId: '00000000-0000-0000-0000-000000000000', id: 'intune-9', deviceName: 'X' });
    expect(m!.externalId).toBe('intune-9');
  });

  it('returns null when no usable id exists', () => {
    expect(mapManagedDevice({ deviceName: 'orphan' })).toBeNull();
  });

  it('uses externalId as the name when deviceName is missing', () => {
    const m = mapManagedDevice({ azureADDeviceId: 'aad-2' });
    expect(m!.name).toBe('aad-2');
  });
});

describe('planRetirements', () => {
  it('retires active synced CIs whose device is gone, ignoring already-retired ones', () => {
    const existing = [
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-2', external_id: 'aad-2', status: 'active' },
      { id: 'ci-3', external_id: 'aad-3', status: 'retired' },
    ];
    const seen = new Set(['aad-1']);
    expect(planRetirements(seen, existing)).toEqual(['ci-2']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npm test -- entra-device-map`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// Pure mapping from Microsoft Graph Intune managedDevice records to CMDB CI
// fields, plus the retirement planner. No I/O — fully unit-testable.

export interface ManagedDevice {
  azureADDeviceId?: string;
  id?: string; // Intune managedDeviceId
  deviceName?: string;
  userPrincipalName?: string;
  operatingSystem?: string;
  osVersion?: string;
  complianceState?: string;
  isEncrypted?: boolean;
  lastSyncDateTime?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  managedDeviceOwnerType?: string;
}

export interface MappedCi {
  externalId: string;
  name: string;
  owner: string | null;
  attributes: Record<string, unknown>;
}

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

export function mapManagedDevice(d: ManagedDevice): MappedCi | null {
  const externalId =
    d.azureADDeviceId && d.azureADDeviceId !== ZERO_GUID ? d.azureADDeviceId : d.id;
  if (!externalId) return null;
  return {
    externalId,
    name: d.deviceName || externalId,
    owner: d.userPrincipalName || null,
    attributes: {
      os: d.operatingSystem ?? null,
      osVersion: d.osVersion ?? null,
      complianceState: d.complianceState ?? null,
      isEncrypted: d.isEncrypted ?? null,
      lastSyncDateTime: d.lastSyncDateTime ?? null,
      manufacturer: d.manufacturer ?? null,
      model: d.model ?? null,
      serialNumber: d.serialNumber ?? null,
      ownerType: d.managedDeviceOwnerType ?? null,
      managedDeviceId: d.id ?? null,
    },
  };
}

export interface ExistingCi {
  id: string;
  external_id: string;
  status: string;
}

/** IDs of currently-active synced CIs whose device no longer appears in the tenant. */
export function planRetirements(seenExternalIds: Set<string>, existing: ExistingCi[]): string[] {
  return existing
    .filter((c) => c.status === 'active' && !seenExternalIds.has(c.external_id))
    .map((c) => c.id);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npm test -- entra-device-map`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/entra/device-map.ts apps/api/test/entra-device-map.test.ts
git commit -m "feat(entra): device->CI mapper and retirement planner"
```

---

## Task 6: Per-org Graph client factory + device enumeration (TDD)

**Files:**
- Create: `apps/api/src/integrations/entra/graph.ts`
- Test: `apps/api/test/entra-graph.test.ts`

- [ ] **Step 1: Write the failing test** (covers the pure pagination logic; `buildOrgGraphClient` needs DB/config and is verified manually in Task 12)

```ts
import { describe, it, expect, vi } from 'vitest';
import { enumerateManagedDevices } from '../src/integrations/entra/graph.js';

describe('enumerateManagedDevices', () => {
  it('follows @odata.nextLink and concatenates all pages', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': 'https://g/next' })
      .mockResolvedValueOnce({ value: [{ id: 'c' }] });
    const client = { get, post: vi.fn() };
    const out = await enumerateManagedDevices(client as any);
    expect(out.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toContain('/deviceManagement/managedDevices');
    expect(get.mock.calls[1][0]).toBe('https://g/next');
  });

  it('handles an empty tenant', async () => {
    const client = { get: vi.fn(async () => ({ value: [] })), post: vi.fn() };
    expect(await enumerateManagedDevices(client as any)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npm test -- entra-graph`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// Builds a Microsoft Graph client bound to a single customer's app registration
// (per-customer isolation) and enumerates that tenant's Intune managed devices.
// Reuses the existing token provider + graph client unchanged.
import { withSystemContext } from '../../db/pool.js';
import { config } from '../../config.js';
import { createTokenProvider } from '../m365/token.js';
import { createGraphClient, type GraphClient } from '../m365/graph-client.js';
import { openSecret, loadMasterKey, type SealedSecret } from './crypto.js';
import type { ManagedDevice } from './device-map.js';

interface CloudEnv {
  login_authority: string;
  graph_endpoint: string;
}

export interface OrgEntraCreds {
  tenantId: string;
  clientId: string;
  secret: SealedSecret;
  cloud: string;
}

/** Build a Graph client for one customer tenant from its stored, encrypted secret. */
export async function buildOrgGraphClient(creds: OrgEntraCreds): Promise<GraphClient> {
  const env = await withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      'SELECT login_authority, graph_endpoint FROM cloud_environments WHERE cloud = $1',
      [creds.cloud],
    );
    if (!rows[0]) throw new Error(`unknown cloud environment: ${creds.cloud}`);
    return rows[0] as CloudEnv;
  });
  const clientSecret = openSecret(creds.secret, loadMasterKey(config.integrationEncKey));
  const tokenProvider = createTokenProvider({
    loginAuthority: env.login_authority,
    graphEndpoint: env.graph_endpoint,
    tenantId: creds.tenantId,
    clientId: creds.clientId,
    clientSecret,
    fetchImpl: fetch as any,
    now: () => Date.now(),
  });
  return createGraphClient({
    graphEndpoint: env.graph_endpoint,
    getToken: tokenProvider.getToken,
    fetchImpl: fetch as any,
  });
}

const SELECT =
  '$select=azureADDeviceId,id,deviceName,userPrincipalName,operatingSystem,osVersion,' +
  'complianceState,isEncrypted,lastSyncDateTime,manufacturer,model,serialNumber,managedDeviceOwnerType';

/** Enumerate every Intune managed device, following @odata.nextLink pages. */
export async function enumerateManagedDevices(client: GraphClient): Promise<ManagedDevice[]> {
  const out: ManagedDevice[] = [];
  let url = `/deviceManagement/managedDevices?${SELECT}`;
  for (;;) {
    const page = await client.get(url);
    for (const d of page.value ?? []) out.push(d as ManagedDevice);
    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    break;
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npm test -- entra-graph`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/entra/graph.ts apps/api/test/entra-graph.test.ts
git commit -m "feat(entra): per-org Graph client factory + managedDevices enumeration"
```

---

## Task 7: Sync orchestrator (TDD)

**Files:**
- Create: `apps/api/src/integrations/entra/sync.ts`
- Test: `apps/api/test/entra-sync.test.ts`

- [ ] **Step 1: Write the failing test** (tests `applyDeviceSync` with a fake `sql` — the upsert/retire core, no Graph/DB needed)

```ts
import { describe, it, expect, vi } from 'vitest';
import { applyDeviceSync } from '../src/integrations/entra/sync.js';
import type { ManagedDevice } from '../src/integrations/entra/device-map.js';

// Fake sql whose query() branches on the SQL text.
function fakeSql(existing: Array<{ id: string; external_id: string; status: string }>) {
  const retired: string[] = [];
  const query = vi.fn(async (text: string, _params?: unknown[]) => {
    if (text.startsWith('INSERT INTO configuration_items')) {
      // Pretend every device is newly inserted (xmax = 0 => inserted true).
      return { rows: [{ inserted: true }] };
    }
    if (text.startsWith('SELECT id, external_id, status')) {
      return { rows: existing };
    }
    if (text.startsWith('UPDATE configuration_items SET status=')) {
      retired.push(_params![0] as string);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { sql: { query } as any, retired };
}

describe('applyDeviceSync', () => {
  it('upserts each device and retires CIs whose device is gone', async () => {
    const devices: ManagedDevice[] = [
      { azureADDeviceId: 'aad-1', deviceName: 'A' },
      { azureADDeviceId: 'aad-2', deviceName: 'B' },
    ];
    const { sql, retired } = fakeSql([
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-gone', external_id: 'aad-old', status: 'active' },
    ]);
    const stats = await applyDeviceSync(sql, 'org-1', devices);
    expect(stats.created).toBe(2);
    expect(stats.retired).toBe(1);
    expect(retired).toEqual(['ci-gone']);
  });

  it('skips unusable records (no id)', async () => {
    const { sql } = fakeSql([]);
    const stats = await applyDeviceSync(sql, 'org-1', [{ deviceName: 'orphan' }]);
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npm test -- entra-sync`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// Orchestrates one tenant's device sync: enumerate -> upsert CIs -> retire gone
// devices (only after a successful enumeration). runEnabledIntegrations() loops
// every enabled org, isolating failures and logging a run row per org.
import { withSystemContext, type Sql } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { buildOrgGraphClient, enumerateManagedDevices } from './graph.js';
import { mapManagedDevice, planRetirements, type ExistingCi, type ManagedDevice } from './device-map.js';
import type { SealedSecret } from './crypto.js';

export interface SyncStats {
  created: number;
  updated: number;
  retired: number;
}

export interface OrgIntegrationRow {
  organization_id: string;
  tenant_id: string;
  client_id: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  key_version: number;
  cloud: string;
}

/** Upsert mapped devices and retire missing ones. Pure DB-glue (testable with a fake sql). */
export async function applyDeviceSync(
  sql: Sql,
  orgId: string,
  devices: ManagedDevice[],
): Promise<SyncStats> {
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const d of devices) {
    const m = mapManagedDevice(d);
    if (!m) continue;
    seen.add(m.externalId);
    const { rows } = await sql.query(
      `INSERT INTO configuration_items
         (organization_id, ci_class, name, status, owner, attributes, source, external_id)
       VALUES ($1,'device',$2,'active',$3,$4,'entra',$5)
       ON CONFLICT (organization_id, source, external_id)
       DO UPDATE SET name = EXCLUDED.name, owner = EXCLUDED.owner,
                     attributes = EXCLUDED.attributes, status = 'active', updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [orgId, m.name, m.owner, JSON.stringify(m.attributes), m.externalId],
    );
    if (rows[0].inserted) created++;
    else updated++;
  }
  // Retirement runs only because enumeration + upserts completed without throwing.
  const existing = (
    await sql.query(
      `SELECT id, external_id, status FROM configuration_items
        WHERE organization_id = $1 AND source = 'entra'`,
      [orgId],
    )
  ).rows as ExistingCi[];
  const toRetire = planRetirements(seen, existing);
  for (const id of toRetire) {
    await sql.query(
      `UPDATE configuration_items SET status='retired', updated_at=now() WHERE id=$1`,
      [id],
    );
  }
  return { created, updated, retired: toRetire.length };
}

/** Full sync for one tenant: build client, enumerate, apply. Throws on Graph failure. */
export async function syncOrg(sql: Sql, row: OrgIntegrationRow): Promise<SyncStats> {
  const secret: SealedSecret = {
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
    keyVersion: row.key_version,
  };
  const client = await buildOrgGraphClient({
    tenantId: row.tenant_id,
    clientId: row.client_id,
    secret,
    cloud: row.cloud,
  });
  const devices = await enumerateManagedDevices(client); // throws -> no retirement happens
  return applyDeviceSync(sql, row.organization_id, devices);
}

/** Records a run row + updates the integration status. */
async function recordRun(
  sql: Sql,
  orgId: string,
  startedAt: string,
  result: { stats?: SyncStats; error?: string },
): Promise<void> {
  const ok = !result.error;
  await sql.query(
    `INSERT INTO integration_sync_runs
       (organization_id, provider, started_at, finished_at, created_count, updated_count, retired_count, status, error)
     VALUES ($1,'entra_graph',$2, now(), $3,$4,$5,$6,$7)`,
    [
      orgId, startedAt,
      result.stats?.created ?? 0, result.stats?.updated ?? 0, result.stats?.retired ?? 0,
      ok ? 'ok' : 'error', result.error ?? null,
    ],
  );
  await sql.query(
    `UPDATE org_integrations
        SET status=$2, last_sync_at=now(), last_error=$3, last_sync_stats=$4, updated_at=now()
      WHERE organization_id=$1 AND provider='entra_graph'`,
    [orgId, ok ? 'ok' : 'error', result.error ?? null, JSON.stringify(result.stats ?? null)],
  );
}

/** Sync one org by id, recording the run. Used by the manual-trigger route. */
export async function runOneOrg(orgId: string): Promise<SyncStats> {
  return withSystemContext(async (sql) => {
    const row = await loadEnabledRow(sql, orgId);
    if (!row) throw new Error('no enabled entra_graph integration for org');
    const startedAt = new Date().toISOString();
    try {
      const stats = await syncOrg(sql, row);
      await recordRun(sql, orgId, startedAt, { stats });
      return stats;
    } catch (err) {
      await recordRun(sql, orgId, startedAt, { error: (err as Error).message });
      throw err;
    }
  });
}

/** Loop every enabled integration; isolate per-org failures. Used by the scheduler. */
export async function runEnabledIntegrations(sql: Sql): Promise<void> {
  const { rows } = await sql.query(
    `SELECT oi.organization_id, oi.tenant_id, oi.client_id,
            oi.secret_ciphertext, oi.secret_iv, oi.secret_tag, oi.key_version, o.cloud
       FROM org_integrations oi
       JOIN organizations o ON o.id = oi.organization_id
      WHERE oi.provider='entra_graph' AND oi.enabled = true`,
  );
  for (const row of rows as OrgIntegrationRow[]) {
    const startedAt = new Date().toISOString();
    try {
      const stats = await syncOrg(sql, row);
      await recordRun(sql, row.organization_id, startedAt, { stats });
      logger.info({ org: row.organization_id, ...stats }, 'entra sync ok');
    } catch (err) {
      await recordRun(sql, row.organization_id, startedAt, { error: (err as Error).message });
      logger.error({ org: row.organization_id, err }, 'entra sync failed');
    }
  }
}

/** Load a single enabled integration row joined to its org cloud. */
export async function loadEnabledRow(sql: Sql, orgId: string): Promise<OrgIntegrationRow | null> {
  const { rows } = await sql.query(
    `SELECT oi.organization_id, oi.tenant_id, oi.client_id,
            oi.secret_ciphertext, oi.secret_iv, oi.secret_tag, oi.key_version, o.cloud
       FROM org_integrations oi
       JOIN organizations o ON o.id = oi.organization_id
      WHERE oi.organization_id=$1 AND oi.provider='entra_graph' AND oi.enabled = true`,
    [orgId],
  );
  return (rows[0] as OrgIntegrationRow) ?? null;
}
```

> Note: `new Date().toISOString()` is fine in API runtime code (the no-`Date.now()` rule applies only to Workflow scripts, not the app).

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npm test -- entra-sync`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/integrations/entra/sync.ts apps/api/test/entra-sync.test.ts
git commit -m "feat(entra): device sync orchestrator with retire-on-complete + run logging"
```

---

## Task 8: Admin module (configure / status / test / enable / trigger)

**Files:**
- Create: `apps/api/src/modules/entra-integrations.ts`

- [ ] **Step 1: Implement the module**

First copy the exact import lines for `Principal`, `authorize`, `audit`, `Errors`, `withSystemContext` from the top of `apps/api/src/modules/services.ts` (paths differ per repo layout — reuse what services.ts uses). Then:

```ts
// Admin service for per-customer Entra/Intune device-sync integrations.
// Secrets are sealed before storage and never returned to clients.
import { withSystemContext } from '../db/pool.js';
import { config } from '../config.js';
import { sealSecret, loadMasterKey } from '../integrations/entra/crypto.js';
import { buildOrgGraphClient, type OrgEntraCreds } from '../integrations/entra/graph.js';
import { loadEnabledRow, runOneOrg } from '../integrations/entra/sync.js';
import type { SealedSecret } from '../integrations/entra/crypto.js';
// import { authorize } from '...'; import { audit } from '...'; import { Errors } from '...';
// import type { Principal } from '...';   // <- mirror modules/services.ts

export interface ConfigureInput {
  organizationId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Create/replace the credentials for an org. Resets status to 'unconfigured' (disabled until tested+enabled). */
export async function configureIntegration(actor: Principal, input: ConfigureInput) {
  authorize(actor, 'integrations.manage', { organizationId: input.organizationId });
  if (!config.integrationEncKey) throw Errors.badRequest('INTEGRATION_ENC_KEY is not configured');
  const sealed = sealSecret(input.clientSecret, loadMasterKey(config.integrationEncKey));
  await withSystemContext(async (sql) => {
    await sql.query(
      `INSERT INTO org_integrations
         (organization_id, provider, tenant_id, client_id, secret_ciphertext, secret_iv, secret_tag, key_version, status, enabled)
       VALUES ($1,'entra_graph',$2,$3,$4,$5,$6,$7,'unconfigured', false)
       ON CONFLICT (organization_id, provider)
       DO UPDATE SET tenant_id=EXCLUDED.tenant_id, client_id=EXCLUDED.client_id,
                     secret_ciphertext=EXCLUDED.secret_ciphertext, secret_iv=EXCLUDED.secret_iv,
                     secret_tag=EXCLUDED.secret_tag, key_version=EXCLUDED.key_version,
                     status='unconfigured', updated_at=now()`,
      [input.organizationId, input.tenantId, input.clientId,
       sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyVersion],
    );
  });
  await audit(actor, {
    action: 'integration.entra.configured', organizationId: input.organizationId,
    resourceType: 'org_integration', resourceId: input.organizationId,
    detail: { tenantId: input.tenantId, clientId: input.clientId },
  });
  return { ok: true };
}

/** Non-secret status view for the admin UI. */
export async function getStatus(actor: Principal, organizationId: string) {
  authorize(actor, 'integrations.manage', { organizationId });
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT organization_id, provider, tenant_id, client_id, enabled, status,
              last_sync_at, last_error, last_sync_stats, updated_at
         FROM org_integrations WHERE organization_id=$1 AND provider='entra_graph'`,
      [organizationId],
    );
    const runs = (await sql.query(
      `SELECT started_at, finished_at, created_count, updated_count, retired_count, status, error
         FROM integration_sync_runs WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 10`,
      [organizationId],
    )).rows;
    return { integration: rows[0] ?? null, runs };
  });
}

/** Enable/disable scheduled sync. */
export async function setEnabled(actor: Principal, organizationId: string, enabled: boolean) {
  authorize(actor, 'integrations.manage', { organizationId });
  await withSystemContext(async (sql) => {
    const { rowCount } = await sql.query(
      `UPDATE org_integrations SET enabled=$2, updated_at=now()
        WHERE organization_id=$1 AND provider='entra_graph'`,
      [organizationId, enabled],
    );
    if (!rowCount) throw Errors.notFound('integration not configured');
  });
  await audit(actor, {
    action: enabled ? 'integration.entra.enabled' : 'integration.entra.disabled',
    organizationId, resourceType: 'org_integration', resourceId: organizationId, detail: {},
  });
  return { ok: true };
}

/** Live connection test: acquire a token and read one device. Does not write CIs. */
export async function testConnection(actor: Principal, organizationId: string) {
  authorize(actor, 'integrations.manage', { organizationId });
  return withSystemContext(async (sql) => {
    const { rows } = await sql.query(
      `SELECT oi.tenant_id, oi.client_id, oi.secret_ciphertext, oi.secret_iv, oi.secret_tag, oi.key_version, o.cloud
         FROM org_integrations oi JOIN organizations o ON o.id=oi.organization_id
        WHERE oi.organization_id=$1 AND oi.provider='entra_graph'`,
      [organizationId],
    );
    if (!rows[0]) throw Errors.notFound('integration not configured');
    const r = rows[0];
    const creds: OrgEntraCreds = {
      tenantId: r.tenant_id, clientId: r.client_id, cloud: r.cloud,
      secret: { ciphertext: r.secret_ciphertext, iv: r.secret_iv, tag: r.secret_tag, keyVersion: r.key_version } as SealedSecret,
    };
    try {
      const client = await buildOrgGraphClient(creds);
      await client.get('/deviceManagement/managedDevices?$top=1');
      await sql.query(`UPDATE org_integrations SET status='ok', last_error=NULL, updated_at=now() WHERE organization_id=$1 AND provider='entra_graph'`, [organizationId]);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      await sql.query(`UPDATE org_integrations SET status='error', last_error=$2, updated_at=now() WHERE organization_id=$1 AND provider='entra_graph'`, [organizationId, msg]);
      return { ok: false, error: msg };
    }
  });
}

/** Manual on-demand sync for one org. */
export async function triggerSync(actor: Principal, organizationId: string) {
  authorize(actor, 'integrations.manage', { organizationId });
  const stats = await runOneOrg(organizationId);
  await audit(actor, {
    action: 'integration.entra.sync', organizationId,
    resourceType: 'org_integration', resourceId: organizationId, detail: stats,
  });
  return stats;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/api && npm run typecheck`
Expected: PASS. (If `Principal`/`authorize`/`audit`/`Errors` import paths are wrong, fix them to match `modules/services.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/entra-integrations.ts
git commit -m "feat(entra): admin module — configure, status, test, enable, trigger"
```

---

## Task 9: Routes

**Files:**
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Import the module**

Near the other module imports at the top of `routes.ts` (e.g. by `import * as integrations from '../modules/integrations.js';`), add:

```ts
import * as entra from '../modules/entra-integrations.js';
```

- [ ] **Step 2: Register the routes**

Inside the same route-builder function, near the existing `/api/v1/integrations/m365/*` routes, add:

```ts
  app.post('/api/v1/integrations/entra/config', async (req, reply) => {
    const p = await requirePrincipal(req);
    const body = z.object({
      organizationId: z.string().uuid(),
      tenantId: z.string().min(1),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    }).parse(req.body);
    reply.code(201);
    return entra.configureIntegration(p, body);
  });

  app.get('/api/v1/integrations/entra/:orgId/status', async (req) => {
    const p = await requirePrincipal(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    return entra.getStatus(p, orgId);
  });

  app.post('/api/v1/integrations/entra/:orgId/test', async (req) => {
    const p = await requirePrincipal(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    return entra.testConnection(p, orgId);
  });

  app.post('/api/v1/integrations/entra/:orgId/enable', async (req) => {
    const p = await requirePrincipal(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    return entra.setEnabled(p, orgId, body.enabled);
  });

  app.post('/api/v1/integrations/entra/:orgId/sync', async (req) => {
    const p = await requirePrincipal(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    return entra.triggerSync(p, orgId);
  });
```

- [ ] **Step 3: Verify it typechecks**

Run: `cd apps/api && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): Entra integration admin + sync routes"
```

---

## Task 10: Scheduler job + server registration

**Files:**
- Create: `apps/api/src/jobs/entra-sync.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Implement the scheduler** (mirrors `apps/api/src/jobs/mail-ingest.ts`)

```ts
// Periodic per-customer Entra/Intune device sync. No-ops unless ENTRA_SYNC_ENABLED.
// Mirrors the mail-ingest scheduler shape.
import { config } from '../config.js';
import { withSystemContext } from '../db/pool.js';
import { runEnabledIntegrations } from '../integrations/entra/sync.js';
import { logger } from '../logger.js';

export function startEntraSync(intervalMs = config.entraSync.intervalMs): NodeJS.Timeout | null {
  if (!config.entraSync.enabled) {
    logger.info('entra device sync disabled (ENTRA_SYNC_ENABLED not true)');
    return null;
  }
  if (!config.integrationEncKey) {
    logger.warn('entra device sync enabled but INTEGRATION_ENC_KEY missing; not scheduling');
    return null;
  }
  const tick = async () => {
    try {
      await withSystemContext(async (sql) => {
        await runEnabledIntegrations(sql);
      });
    } catch (err) {
      logger.error({ err }, 'entra sync tick failed');
    }
  };
  setTimeout(tick, 30_000); // first run shortly after boot
  return setInterval(tick, intervalMs);
}
```

- [ ] **Step 2: Register it in the server**

In `apps/api/src/server.ts`, near `import { startMailIngest } from './jobs/mail-ingest.js';`, add:

```ts
import { startEntraSync } from './jobs/entra-sync.js';
```

Then, immediately after the existing `startMailIngest(...)` call, add:

```ts
  startEntraSync();
```

- [ ] **Step 3: Verify it typechecks**

Run: `cd apps/api && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/entra-sync.ts apps/api/src/server.ts
git commit -m "feat(entra): scheduled per-org device sync job"
```

---

## Task 11: Web admin page

**Files:**
- Create: `apps/web/app/(app)/integrations/page.tsx`

- [ ] **Step 1: Inspect the existing admin page pattern**

Read `apps/web/app/(app)/team/page.tsx` (the platform user-admin page) to copy this repo's conventions for: the API client/fetch helper, auth header handling, and form/list styling. Reuse the same fetch helper rather than calling `fetch` raw.

- [ ] **Step 2: Implement the page**

Create a client component that, for a selected org (reuse however `team/page.tsx` selects/loads orgs):
- Renders a form with `tenantId`, `clientId`, `clientSecret` (the secret field is `type="password"`, write-only — never pre-filled from the server).
- **Save** → `POST /api/v1/integrations/entra/config`.
- **Test connection** → `POST /api/v1/integrations/entra/:orgId/test`; show `ok`/`error`.
- **Enable/Disable** toggle → `POST /api/v1/integrations/entra/:orgId/enable`.
- **Sync now** → `POST /api/v1/integrations/entra/:orgId/sync`; show returned `{created, updated, retired}`.
- Loads `GET /api/v1/integrations/entra/:orgId/status` to show `status`, `last_sync_at`, `last_error`, and the recent runs table.
- Shows a static help line: *"In the customer's Entra tenant, create an app registration and grant admin consent for the application permission `DeviceManagementManagedDevices.Read.All`."*

Match the styling and data-fetching idioms from `team/page.tsx` exactly; do not introduce a new fetch/state pattern.

- [ ] **Step 3: Verify the web app typechecks/builds**

Run: `cd apps/web && npm run typecheck` (or `npm run lint` if no typecheck script — check `apps/web/package.json`).
Expected: PASS.
> Do NOT run `next build` while `next dev` is running — it corrupts `apps/web/.next` (white page / 500s). If that happens: `rm -rf apps/web/.next` and restart dev.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/integrations/page.tsx"
git commit -m "feat(web): Entra device-sync integration admin page"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole API test suite**

Run: `cd apps/api && npm test`
Expected: PASS — all suites green, including the four new `entra-*` suites.

- [ ] **Step 2: Typecheck both apps**

Run: `cd apps/api && npm run typecheck` then `cd apps/web && npm run typecheck`
Expected: PASS for both.

- [ ] **Step 3: Generate a dev encryption key and configure env**

Generate a 32-byte base64 key:

Run: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

Add to your dev `.env` (repo root): `INTEGRATION_ENC_KEY=<the value>` and `ENTRA_SYNC_ENABLED=false` (leave the scheduler off; we test via the manual button).

- [ ] **Step 4: Manual end-to-end smoke (real tenant or documented skip)**

Start the API + web (per the repo's normal dev commands). As a user holding `integrations.manage`:
1. Open `/integrations`, pick an org, enter a real customer tenant's `tenantId`/`clientId`/`clientSecret` (app must have `DeviceManagementManagedDevices.Read.All` admin-consented).
2. Click **Test connection** → expect `ok: true`.
3. Click **Sync now** → expect `{created > 0, updated, retired}`.
4. Open the CMDB / configuration-items list → confirm `device` CIs appear with `source='entra'`, an `external_id`, and `attributes.complianceState` populated.
5. Click **Sync now** again → expect `created: 0, updated: N` (idempotent upsert; no duplicates).
6. In the DB, confirm `integration_sync_runs` has rows and `org_integrations.last_sync_at` updated.

If no real tenant is available, record that this step was **skipped** (do not claim it passed) and note that the automated suites + typecheck are green.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(entra): verification fixups"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** per-customer app reg (Task 7/8 use per-org creds) · envelope encryption (Task 4) · `org_integrations` + provenance + sync-run tables (Task 1) · devices+Intune compliance scope (Task 5 mapping) · upsert-by-external-id + retire-on-disappearance with completed-run gate (Task 7) · admin UX incl. write-only secret + consent string (Tasks 8/11) · `integrations.manage` perm + audit (Tasks 2/8) · scheduler + manual trigger (Tasks 7/9/10) · tests (Tasks 4–7) · KV-blocked constraint honored (env master key, Task 3).
- **Type consistency:** `SealedSecret`, `MappedCi`, `ManagedDevice`, `ExistingCi`, `OrgEntraCreds`, `OrgIntegrationRow`, `SyncStats` are defined once and reused with matching field names across `crypto.ts`/`device-map.ts`/`graph.ts`/`sync.ts`/`entra-integrations.ts`. The upsert RETURNING `inserted` flag drives `created` vs `updated` consistently in `applyDeviceSync` and its test.
- **Out of scope (per spec):** no user/group sync, no `ci_relationships` ownership edges, no Graph delta/webhooks, no Key Vault, no auto-criticality.
```
