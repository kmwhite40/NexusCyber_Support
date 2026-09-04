// Loads a customer's Entra staff into Nexus users. DRY RUN unless --apply is passed.
//
// Run as an operator tool rather than behind a route because it needs no session and writes an
// honest actor: an audit row attributed to the system is true, whereas borrowing a real person's
// id to make a script work would put a false actor into a hash-chained compliance log.
//
// Usage (from apps/api):
//   ORG_ID=... npx tsx src/scripts/sync-entra-users.ts            # dry run
//   ORG_ID=... npx tsx src/scripts/sync-entra-users.ts --apply
import { withSystemContext } from '../db/pool.js';
import { config } from '../config.js';
import { audit } from '../modules/audit.js';
import { isStaffAccount, mapEntraUser, applyUserSync, type EntraUser, type MappedUser } from '../integrations/entra/user-sync.js';

const APPLY = process.argv.includes('--apply');
const ORG_ID = process.env.ORG_ID ?? '';
const ROLE = process.env.ROLE_KEY ?? config.oidcCustomer.defaultRoleKey;
if (!ORG_ID) { console.error('ORG_ID is required'); process.exit(1); }

const { tenantId, clientId, clientSecret, upnDomain, cloud } = config.provisioning;
if (!tenantId || !clientId || !clientSecret || !upnDomain) {
  console.error('M365_PROV_* is not fully configured; nothing to authenticate with.');
  process.exit(1);
}

const env = await withSystemContext(async (sql) => (await sql.query(
  'SELECT login_authority, graph_endpoint FROM cloud_environments WHERE cloud=$1', [cloud])).rows[0]);
if (!env) { console.error(`unknown cloud environment: ${cloud}`); process.exit(1); }

const body = new URLSearchParams({
  client_id: clientId, client_secret: clientSecret,
  scope: `${env.graph_endpoint}/.default`, grant_type: 'client_credentials',
});
const tokenRes = await fetch(`${env.login_authority}/${tenantId}/oauth2/v2.0/token`, { method: 'POST', body });
const token = (await tokenRes.json() as any).access_token;
if (!token) { console.error('could not acquire a token'); process.exit(1); }

// $select must name every field the filter and mapper read — Graph silently omits the rest, and
// an unselected assignedLicenses would make every account look unlicensed and import nobody.
const SELECT = '$select=id,userPrincipalName,displayName,givenName,surname,userType,accountEnabled,assignedLicenses';
let url: string | null = `${env.graph_endpoint}/v1.0/users?${SELECT}&$top=999`;
const all: EntraUser[] = [];
for (let page = 0; url && page < 50; page += 1) {
  const res: any = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (res.error) { console.error('graph error:', JSON.stringify(res.error)); process.exit(1); }
  all.push(...(res.value ?? []));
  url = res['@odata.nextLink'] ?? null;
}

const staff = all.filter((u) => isStaffAccount(u, upnDomain));
const mapped = staff.map(mapEntraUser).filter((m): m is MappedUser => m !== null);

console.log(`tenant accounts read : ${all.length}`);
console.log(`licensed members @${upnDomain}: ${staff.length}`);
console.log(`mappable             : ${mapped.length}`);
console.log(`role for new users   : ${ROLE}`);

const existing = await withSystemContext(async (sql) => (await sql.query(
  `SELECT lower(email) AS email, external_id FROM users
    WHERE organization_id=$1 AND plane='customer'`, [ORG_ID])).rows as Array<{ email: string; external_id: string | null }>);

// Entra ids are matched GLOBALLY, because users.external_id is globally unique — several staff
// are also operator accounts in the nexus plane. A preview that only looked at this org's
// customer users over-reported creates by exactly that number, which is the one thing a dry run
// must not do: it existed to tell you what will happen.
const takenOids = await withSystemContext(async (sql) => new Set(
  (await sql.query('SELECT external_id FROM users WHERE external_id IS NOT NULL')).rows
    .map((r: { external_id: string }) => r.external_id)));
const byOid = takenOids;
const byEmail = new Set(existing.map((e) => e.email));
const wouldCreate = mapped.filter((m) => !byOid.has(m.externalId) && !byEmail.has(m.email));
const wouldLink = mapped.filter((m) => !byOid.has(m.externalId) && byEmail.has(m.email));
const seen = new Set(mapped.map((m) => m.externalId));
const wouldSuspend = existing.filter((e) => e.external_id && !seen.has(e.external_id));

console.log(`\nalready in Nexus     : ${existing.length}`);
const wouldSkip = mapped.filter((m) => takenOids.has(m.externalId)
  && !existing.some((e) => e.external_id === m.externalId));
console.log(`would CREATE         : ${wouldCreate.length}`);
console.log(`would SKIP (already an identity elsewhere): ${wouldSkip.length}`);
console.log(`would LINK by email  : ${wouldLink.length}`);
console.log(`would SUSPEND        : ${wouldSuspend.length}  ${wouldSuspend.map((e) => e.email).join(', ')}`);
console.log('\nsample of new users:');
for (const m of wouldCreate.slice(0, 5)) console.log(`   ${m.email}  ${m.displayName}`);

if (!APPLY) {
  console.log('\n── DRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

const stats = await withSystemContext((sql) => applyUserSync(sql, ORG_ID, mapped, ROLE));
console.log('\nRESULT ' + JSON.stringify(stats));
// actor null = system. Honest attribution for a script nobody signed into.
await audit(null, {
  action: 'integration.entra.user_sync', organizationId: ORG_ID,
  resourceType: 'organization', resourceId: ORG_ID, detail: { ...stats, source: 'sync-entra-users.ts' },
});
process.exit(0);
