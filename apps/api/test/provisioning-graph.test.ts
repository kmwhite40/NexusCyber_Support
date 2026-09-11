import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSkus,
  normalizePolicies,
  readTenantState,
  findUserByUpn,
  directoryRoleCount,
  createUser,
  assignLicenses,
  userLicenseSkuIds,
  addToGroup,
  issueTap,
  graphErrorCode,
  setManager,
  listSelectableGroups,
  getCloudPcStatus,
  listGroupsByDisplayName,
  isAlreadyMemberError,
  isTapPolicyDisabledError,
  normalizeTapEnabled,
} from '../src/integrations/m365/provisioning-graph.js';
import { GraphError } from '../src/integrations/m365/graph-client.js';

describe('normalizeSkus', () => {
  it('projects the seat counts used for availability checks', () => {
    const out = normalizeSkus({ value: [
      { skuId: 'a', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', prepaidUnits: { enabled: 10 }, consumedUnits: 7 },
    ] });
    expect(out).toEqual([{ skuId: 'a', skuPartNumber: 'SPE_E3_USGOV_GCCHIGH', enabled: 10, consumed: 7 }]);
  });

  it('tolerates a missing prepaidUnits block', () => {
    expect(normalizeSkus({ value: [{ skuId: 'b', skuPartNumber: 'X' }] }))
      .toEqual([{ skuId: 'b', skuPartNumber: 'X', enabled: 0, consumed: 0 }]);
  });
});

describe('normalizePolicies', () => {
  it('extracts assignment group ids', () => {
    const out = normalizePolicies({ value: [{
      id: 'p1', displayName: 'SBSFederal Cloud PC',
      assignments: [{ target: { groupId: 'g1' } }, { target: { groupId: 'g2' } }],
    }] });
    expect(out).toEqual([{ id: 'p1', displayName: 'SBSFederal Cloud PC', groupIds: ['g1', 'g2'] }]);
  });

  it('drops assignments with no group id', () => {
    const out = normalizePolicies({ value: [{
      id: 'p1', displayName: 'X',
      assignments: [{ target: {} }, { target: { groupId: 'g1' } }],
    }] });
    expect(out).toEqual([{ id: 'p1', displayName: 'X', groupIds: ['g1'] }]);
  });

  it('tolerates a missing assignments block', () => {
    expect(normalizePolicies({ value: [{ id: 'p1', displayName: 'X' }] }))
      .toEqual([{ id: 'p1', displayName: 'X', groupIds: [] }]);
  });
});

describe('readTenantState', () => {
  it('reads skus from the v1.0 client and policies from the beta client', async () => {
    const g = {
      get: vi.fn(async () => ({ value: [{ skuId: 'a', skuPartNumber: 'X', prepaidUnits: { enabled: 1 }, consumedUnits: 0 }] })),
      post: vi.fn(), patch: vi.fn(),
    } as any;
    const policyBeta = {
      get: vi.fn(async () => ({ value: [{ id: 'p1', displayName: 'D', assignments: [] }] })),
      post: vi.fn(), patch: vi.fn(),
    } as any;

    const state = await readTenantState(g, policyBeta);

    expect(g.get).toHaveBeenCalledWith('/subscribedSkus');
    expect(policyBeta.get).toHaveBeenCalledWith(
      '/deviceManagement/virtualEndpoint/provisioningPolicies?$expand=assignments',
    );
    // The two reads must not be cross-wired to the wrong client.
    expect(policyBeta.get).not.toHaveBeenCalledWith('/subscribedSkus');
    expect(state).toEqual({
      skus: [{ skuId: 'a', skuPartNumber: 'X', enabled: 1, consumed: 0 }],
      policies: [{ id: 'p1', displayName: 'D', groupIds: [] }],
    });
  });
});

describe('findUserByUpn', () => {
  it('builds an OData filter and returns the first match', async () => {
    const get = vi.fn(async () => ({ value: [{ id: 'u1', userPrincipalName: 'a.b@x.gov' }] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    const out = await findUserByUpn(g, 'a.b@x.gov');
    expect(out).toEqual({ id: 'u1', userPrincipalName: 'a.b@x.gov' });
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain('/users?$filter=');
    // encodeURIComponent leaves ' unescaped (it's URI-safe); the literal is still quoted.
    expect(url).toContain(encodeURIComponent("userPrincipalName eq 'a.b@x.gov'"));
  });

  it('returns null when no user matches', async () => {
    const g = { get: vi.fn(async () => ({ value: [] })), post: vi.fn(), patch: vi.fn() } as any;
    expect(await findUserByUpn(g, 'nobody@x.gov')).toBeNull();
  });

  it('doubles embedded single quotes instead of leaving them unescaped', async () => {
    const get = vi.fn(async () => ({ value: [] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    await findUserByUpn(g, "o'brien@x.gov");
    const url = get.mock.calls[0][0] as string;
    // '' is the OData-escaped form of a literal single quote inside a string literal.
    expect(url).toContain(encodeURIComponent("userPrincipalName eq 'o''brien@x.gov'"));
    // The raw, un-doubled quote must never appear inside the filter's URL-encoded literal —
    // that would let a crafted UPN terminate the string early and inject filter syntax.
    expect(url).not.toContain("o'brien");
  });
});

describe('directoryRoleCount', () => {
  it('counts directory role memberships', async () => {
    const g = { get: vi.fn(async () => ({ value: [{ id: 'r1' }, { id: 'r2' }] })), post: vi.fn(), patch: vi.fn() } as any;
    expect(await directoryRoleCount(g, 'u1')).toBe(2);
    expect(g.get).toHaveBeenCalledWith('/users/u1/memberOf/microsoft.graph.directoryRole?$select=id');
  });

  it('is zero for an empty result', async () => {
    const g = { get: vi.fn(async () => ({ value: [] })), post: vi.fn(), patch: vi.fn() } as any;
    expect(await directoryRoleCount(g, 'u1')).toBe(0);
  });
});

describe('createUser', () => {
  it('posts the account body to /users', async () => {
    const post = vi.fn(async () => ({ id: 'u1' }));
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    const body = { displayName: 'Jane Doe', userPrincipalName: 'jane@x.gov' };
    const out = await createUser(g, body);
    expect(post).toHaveBeenCalledWith('/users', body);
    expect(out).toEqual({ id: 'u1' });
  });
});

describe('assignLicenses', () => {
  it('posts addLicenses with empty disabledPlans and no removals', async () => {
    const post = vi.fn(async () => ({}));
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    await assignLicenses(g, 'u1', ['sku-a', 'sku-b']);
    expect(post).toHaveBeenCalledWith('/users/u1/assignLicense', {
      addLicenses: [{ skuId: 'sku-a', disabledPlans: [] }, { skuId: 'sku-b', disabledPlans: [] }],
      removeLicenses: [],
    });
  });
});

describe('userLicenseSkuIds', () => {
  it('projects the assigned sku ids', async () => {
    const g = { get: vi.fn(async () => ({ value: [{ skuId: 's1' }, { skuId: 's2' }] })), post: vi.fn(), patch: vi.fn() } as any;
    expect(await userLicenseSkuIds(g, 'u1')).toEqual(['s1', 's2']);
  });
});

describe('addToGroup', () => {
  it('builds the @odata.id from the supplied graph endpoint, not a hardcoded host', async () => {
    const post = vi.fn(async () => null);
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    await addToGroup(g, 'group-1', 'user-1', 'https://graph.microsoft.us');
    expect(post).toHaveBeenCalledWith('/groups/group-1/members/$ref', {
      '@odata.id': 'https://graph.microsoft.us/v1.0/directoryObjects/user-1',
    });
  });

  it('follows a commercial endpoint just as faithfully', async () => {
    const post = vi.fn(async () => null);
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    await addToGroup(g, 'group-1', 'user-1', 'https://graph.microsoft.com');
    expect(post).toHaveBeenCalledWith('/groups/group-1/members/$ref', {
      '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/user-1',
    });
  });

  it('tolerates a trailing slash on the configured endpoint', async () => {
    const post = vi.fn(async () => null);
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    await addToGroup(g, 'group-1', 'user-1', 'https://graph.microsoft.us/');
    expect(post).toHaveBeenCalledWith('/groups/group-1/members/$ref', {
      '@odata.id': 'https://graph.microsoft.us/v1.0/directoryObjects/user-1',
    });
  });
});

describe('issueTap', () => {
  // Single-use regardless of lifetime: that is what keeps a longer pass from becoming a standing
  // credential. The duration itself is now configuration, not a constant baked in here.
  it('requests a single-use pass with the lifetime it is given', async () => {
    const post = vi.fn(async () => ({ id: 'tap1', temporaryAccessPass: 'abc' }));
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    const out = await issueTap(g, 'u1', 480);
    expect(post).toHaveBeenCalledWith('/users/u1/authentication/temporaryAccessPassMethods', {
      isUsableOnce: true, lifetimeInMinutes: 480,
    });
    expect(out).toEqual({ id: 'tap1', temporaryAccessPass: 'abc' });
  });
});

describe('getCloudPcStatus', () => {
  it('filters cloudPCs by the userPrincipalName it is actually given', async () => {
    const get = vi.fn(async () => ({ value: [{ status: 'provisioned' }] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    const status = await getCloudPcStatus(g, 'jane@x.gov');
    expect(status).toBe('provisioned');
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain('/deviceManagement/virtualEndpoint/cloudPCs?$filter=');
    expect(url).toContain(encodeURIComponent("userPrincipalName eq 'jane@x.gov'"));
  });

  it('returns null when no Cloud PC is found', async () => {
    const g = { get: vi.fn(async () => ({ value: [] })), post: vi.fn(), patch: vi.fn() } as any;
    expect(await getCloudPcStatus(g, 'jane@x.gov')).toBeNull();
  });

  it('escapes a single quote in the upn instead of injecting filter syntax', async () => {
    const get = vi.fn(async () => ({ value: [] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    await getCloudPcStatus(g, "o'brien@x.gov");
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("userPrincipalName eq 'o''brien@x.gov'"));
  });
});

describe('listGroupsByDisplayName', () => {
  it('filters by the names it is given and projects id/displayName', async () => {
    const get = vi.fn(async () => ({ value: [{ id: 'g1', displayName: 'All Staff' }] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    const out = await listGroupsByDisplayName(g, ['All Staff']);
    expect(out).toEqual([{ id: 'g1', displayName: 'All Staff' }]);
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain('/groups?$filter=');
    expect(url).toContain('$select=id,displayName');
    expect(url).toContain(encodeURIComponent("displayName eq 'All Staff'"));
  });

  it('joins several names into one filter', async () => {
    const get = vi.fn(async () => ({ value: [] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    await listGroupsByDisplayName(g, ['All Staff', 'Engineering']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0] as string)
      .toContain(encodeURIComponent("displayName eq 'All Staff' or displayName eq 'Engineering'"));
  });

  // Group names are FREE TEXT typed on a request form — strictly more attacker-reachable than a
  // UPN — so the same OData literal escaping the upn filters get is pinned here too. Without
  // the doubled quote, everything after the apostrophe is parsed as filter syntax.
  it('doubles embedded single quotes instead of injecting filter syntax', async () => {
    const get = vi.fn(async () => ({ value: [] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    await listGroupsByDisplayName(g, ["O'Brien's Team"]);
    expect(get.mock.calls[0][0] as string)
      .toContain(encodeURIComponent("displayName eq 'O''Brien''s Team'"));
  });

  it('chunks long name lists into several requests and concatenates the results', async () => {
    const names = Array.from({ length: 16 }, (_, i) => `Group ${i}`);
    const get = vi.fn(async (url: string) =>
      url.includes(encodeURIComponent('Group 15'))
        ? { value: [{ id: 'g15', displayName: 'Group 15' }] }
        : { value: [{ id: 'g0', displayName: 'Group 0' }] });
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    const out = await listGroupsByDisplayName(g, names);
    expect(get).toHaveBeenCalledTimes(2); // 15 per chunk
    expect(out).toEqual([
      { id: 'g0', displayName: 'Group 0' },
      { id: 'g15', displayName: 'Group 15' },
    ]);
  });

  it('de-duplicates and drops blank names, and makes no request at all for none', async () => {
    const get = vi.fn(async () => ({ value: [] }));
    const g = { get, post: vi.fn(), patch: vi.fn() } as any;
    await listGroupsByDisplayName(g, ['All Staff', ' All Staff ', '']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0] as string).toContain(encodeURIComponent("displayName eq 'All Staff'"));
    expect(get.mock.calls[0][0] as string).not.toContain(' or ');

    const get2 = vi.fn(async () => ({ value: [] }));
    await listGroupsByDisplayName({ get: get2, post: vi.fn(), patch: vi.fn() } as any, ['', '  ']);
    expect(get2).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 4 — group steps must be idempotent, or retry is broken
// ---------------------------------------------------------------------------

/** The response Graph actually returns for a duplicate `members/$ref` reference. */
const DUPLICATE_MEMBER_BODY = JSON.stringify({
  error: {
    code: 'Request_BadRequest',
    message: "One or more added object references already exist for the following modified properties: 'members'.",
  },
});

describe('isAlreadyMemberError', () => {
  it('recognises the duplicate-reference 400 Graph returns for members/$ref', () => {
    expect(isAlreadyMemberError(new GraphError(400, DUPLICATE_MEMBER_BODY))).toBe(true);
  });

  it('is tolerant of how the condition is worded', () => {
    expect(isAlreadyMemberError(new GraphError(400, '{"error":{"message":"Object already exists in members"}}'))).toBe(true);
    expect(isAlreadyMemberError(new GraphError(400, '{"error":{"message":"User is already a member of this group"}}'))).toBe(true);
    expect(isAlreadyMemberError(new GraphError(400, '{"error":{"message":"ALREADY EXIST"}}'))).toBe(true);
  });

  // The dangerous direction. Request_BadRequest is the code Graph uses for malformed bodies, a
  // wrong @odata.id host and invalid GUIDs alike. Accepting the CODE would let a group add that
  // genuinely failed report success and hand the new hire an account missing its access.
  it('does NOT accept a Request_BadRequest that says something else', () => {
    expect(isAlreadyMemberError(new GraphError(400, JSON.stringify({
      error: { code: 'Request_BadRequest', message: 'Invalid object identifier.' },
    })))).toBe(false);
  });

  it('does NOT accept other statuses, or non-Graph errors', () => {
    expect(isAlreadyMemberError(new GraphError(403, DUPLICATE_MEMBER_BODY))).toBe(false);
    expect(isAlreadyMemberError(new GraphError(404, DUPLICATE_MEMBER_BODY))).toBe(false);
    expect(isAlreadyMemberError(new Error('already exists'))).toBe(false);
    expect(isAlreadyMemberError(null)).toBe(false);
  });
});

describe('addToGroup idempotency', () => {
  // THE REGRESSION. A run that failed at issue_tap (or anywhere after add_groups) could not be
  // retried: the retry hit the duplicate-reference 400 AT add_groups and stopped there, never
  // reaching the step that actually needed re-running — directly contradicting the "completed
  // steps adopt existing objects" guarantee the whole retry story rests on.
  it('adopts an existing membership instead of failing the retry', async () => {
    const g = { get: vi.fn(), patch: vi.fn(), post: vi.fn(async () => { throw new GraphError(400, DUPLICATE_MEMBER_BODY); }) };
    await expect(addToGroup(g as any, 'group-1', 'user-1', 'https://graph.microsoft.us')).resolves.toBeNull();
    expect(g.post).toHaveBeenCalledTimes(1); // it really did attempt the write
  });

  it('still propagates a group add that genuinely failed', async () => {
    const g = { get: vi.fn(), patch: vi.fn(), post: vi.fn(async () => { throw new GraphError(403, '{"error":{"message":"Insufficient privileges"}}'); }) };
    await expect(addToGroup(g as any, 'group-1', 'user-1', 'https://graph.microsoft.us')).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 5 — spec open item #4: TAP policy not enabled is a SKIP, not a failure
// ---------------------------------------------------------------------------
describe('isTapPolicyDisabledError', () => {
  it('recognises a tenant with the Temporary Access Pass method turned off', () => {
    expect(isTapPolicyDisabledError(new GraphError(400, JSON.stringify({
      error: { code: 'badRequest', message: 'Temporary Access Pass is not enabled for the tenant.' },
    })))).toBe(true);
    expect(isTapPolicyDisabledError(new GraphError(403, JSON.stringify({
      error: { message: 'The temporaryAccessPass authentication method policy is disabled.' },
    })))).toBe(true);
    expect(isTapPolicyDisabledError(new GraphError(400, JSON.stringify({
      error: { message: 'Temporary Access Pass is not allowed for this user.' },
    })))).toBe(true);
  });

  // The dangerous direction again: a missing app permission is also a 403, and downgrading it
  // to "skipped" would report a run as fine while nobody can sign in and nobody was told why.
  it('does NOT treat an ordinary authorization failure as a disabled policy', () => {
    expect(isTapPolicyDisabledError(new GraphError(403, JSON.stringify({
      error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' },
    })))).toBe(false);
  });

  it('does NOT treat an unrelated failure that merely mentions the method as disabled', () => {
    expect(isTapPolicyDisabledError(new GraphError(400, '{"error":{"message":"Temporary Access Pass length is invalid."}}'))).toBe(false);
    expect(isTapPolicyDisabledError(new GraphError(500, '{"error":{"message":"Temporary Access Pass is not enabled."}}'))).toBe(false);
    expect(isTapPolicyDisabledError(new Error('not enabled'))).toBe(false);
  });
});

// The TAP pre-skip decides whether a run issues a first-sign-in credential, and every planner and
// executor test builds `tenant.tapEnabled` by hand — so nothing anywhere proved this function can
// read Graph's actual shape. That is precisely the pattern that shipped three defects behind a
// green suite already (an ON CONFLICT that could never match, a permission that lived only in
// seed, and a probe result that was an authorization artifact).
describe('normalizeTapEnabled', () => {
  const policy = (state: string) => ({
    '@odata.context': 'https://graph.microsoft.us/v1.0/$metadata#policies/authenticationMethodsPolicy',
    id: 'authenticationMethodsPolicy',
    authenticationMethodConfigurations: [
      { id: 'Fido2', state: 'enabled' },
      { id: 'TemporaryAccessPass', state, isUsableOnce: false },
      { id: 'Sms', state: 'disabled' },
    ],
  });

  it('reads an enabled TAP policy', () => {
    expect(normalizeTapEnabled(policy('enabled'))).toBe(true);
  });

  it('reads a disabled TAP policy — the state this tenant is actually in', () => {
    expect(normalizeTapEnabled(policy('disabled'))).toBe(false);
  });

  it('matches the TAP entry case-insensitively', () => {
    expect(normalizeTapEnabled({
      authenticationMethodConfigurations: [{ id: 'temporaryAccessPass', state: 'Enabled' }],
    })).toBe(true);
  });

  // UNKNOWN, not false. Returning false for an unreadable policy would pre-skip the credential
  // step in a tenant where TAP works perfectly well.
  it('returns undefined when the policy could not be read', () => {
    expect(normalizeTapEnabled(null)).toBeUndefined();
    expect(normalizeTapEnabled({})).toBeUndefined();
    expect(normalizeTapEnabled({ authenticationMethodConfigurations: [] })).toBeUndefined();
    expect(normalizeTapEnabled({ authenticationMethodConfigurations: [{ id: 'Fido2', state: 'enabled' }] }))
      .toBeUndefined();
    expect(normalizeTapEnabled({ authenticationMethodConfigurations: [{ id: 'TemporaryAccessPass' }] }))
      .toBeUndefined();
  });
});

describe('readTenantState reads the TAP policy', () => {
  const skuRes = { value: [{ skuId: 'a', skuPartNumber: 'X', prepaidUnits: { enabled: 1 }, consumedUnits: 0 }] };
  const tapRes = { authenticationMethodConfigurations: [{ id: 'TemporaryAccessPass', state: 'disabled' }] };

  function clients(tapImpl: () => Promise<any>) {
    const g = {
      get: vi.fn(async (url: string) =>
        (url.includes('authenticationMethodsPolicy') ? tapImpl() : skuRes)),
      post: vi.fn(), patch: vi.fn(),
    } as any;
    const beta = { get: vi.fn(async () => ({ value: [] })), post: vi.fn(), patch: vi.fn() } as any;
    return { g, beta };
  }

  it('calls the policy endpoint and wires the result through', async () => {
    const { g, beta } = clients(async () => tapRes);
    const state = await readTenantState(g, beta);
    expect(g.get).toHaveBeenCalledWith('/policies/authenticationMethodsPolicy');
    expect(state.tapEnabled).toBe(false);
  });

  // Policy.Read.All is an ADDITION to the design's standing permission list. A tenant that has
  // not granted it must still be able to plan a run — the read failing is UNKNOWN, not fatal.
  it('survives the policy read failing, leaving TAP state unknown', async () => {
    const { g, beta } = clients(async () => { throw new Error('Authorization_RequestDenied'); });
    const state = await readTenantState(g, beta);
    expect(state.tapEnabled).toBeUndefined();
    expect(state.skus).toHaveLength(1);
  });
});

// A run failed in production with nothing to go on but "issuing the Temporary Access Pass failed
// (Graph 404)". The adapter deliberately keeps the Graph response away from the error path,
// because a TAP request that fails AFTER Graph has minted a pass would otherwise carry the pass
// out in the message. But that reasoning covers the RESPONSE BODY of a success; it swallowed the
// error payload too, and with it the only thing that says which 404 this is — a user the
// authentication-methods service cannot resolve yet, or a segment this cloud does not serve on
// this API version. Graph's `error.code` is a diagnostic label from a fixed vocabulary; it is
// never request content and never a credential.
describe('graphErrorCode', () => {
  it('names the Graph error code so a failure can be diagnosed', () => {
    const err = new GraphError(404, '{"error":{"code":"ResourceNotFound","message":"Resource not found for the segment."}}');
    expect(graphErrorCode(err)).toBe('ResourceNotFound');
  });

  it('is undefined rather than guessing when the body is not a Graph error', () => {
    expect(graphErrorCode(new GraphError(502, '<html>bad gateway</html>'))).toBeUndefined();
    expect(graphErrorCode(new GraphError(404, ''))).toBeUndefined();
    expect(graphErrorCode(new Error('network'))).toBeUndefined();
  });

  // The code is the ONLY field taken. Graph's `message` can echo request content, and this value
  // goes into an operator-visible outcome that lands on a ticket.
  it('takes only the code, never the message', () => {
    const err = new GraphError(400, '{"error":{"code":"badRequest","message":"secret-ish detail"}}');
    expect(graphErrorCode(err)).toBe('badRequest');
    expect(JSON.stringify(graphErrorCode(err))).not.toContain('secret-ish');
  });
});

// The up-front TAP-policy read exists so a tenant with the method turned off is pre-skipped
// rather than failing a run after the account, licences and groups are already written. Reading
// it needs Policy.Read.All — a permission this tenant's app registration was never granted — so
// the read has been returning 403 and `.catch(() => null)` turned that into "unknown", which is
// indistinguishable from a healthy read of a tenant whose state simply could not be determined.
// A guard that has never once run reports the same thing as a guard that ran and found nothing.
describe('readTenantState when the TAP policy cannot be read', () => {
  it('says so in the log instead of failing silently', async () => {
    const { logger } = await import('../src/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as any);
    const g = {
      get: vi.fn(async (p: string) => {
        if (p.startsWith('/policies/')) throw new GraphError(403, '{"error":{"code":"Authorization_RequestDenied"}}');
        return { value: [] };
      }),
    } as any;
    const beta = { get: vi.fn(async () => ({ value: [] })) } as any;

    const state = await readTenantState(g, beta);

    // Still non-fatal, and still "unknown" — that part was right.
    expect(state.tapEnabled).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const arg = JSON.stringify(warn.mock.calls[0]);
    expect(arg).toMatch(/Authorization_RequestDenied|403/);
    warn.mockRestore();
  });
});

// The manager relationship is a reference, not a property: PUT /users/{id}/manager/$ref with an
// @odata.id pointing at the manager's directory object. As with addToGroup, the HOST in that
// reference must match the endpoint the client authenticated against — graph.microsoft.us here,
// not the commercial graph.microsoft.com — so it is a required parameter rather than a literal.
describe('setManager', () => {
  it('PUTs an @odata.id reference on the tenant\'s own Graph host', async () => {
    const put = vi.fn(async () => null);
    const g = { put } as any;
    await setManager(g, 'u1', 'mgr-oid', 'https://graph.microsoft.us');
    expect(put).toHaveBeenCalledWith('/users/u1/manager/$ref', {
      '@odata.id': 'https://graph.microsoft.us/v1.0/directoryObjects/mgr-oid',
    });
  });

  it('does not double the slash when the endpoint carries a trailing one', async () => {
    const put = vi.fn(async () => null);
    await setManager({ put } as any, 'u1', 'm', 'https://graph.microsoft.us/');
    expect(put.mock.calls[0][1]).toEqual({
      '@odata.id': 'https://graph.microsoft.us/v1.0/directoryObjects/m',
    });
  });
});

// "Security / distribution groups" was a free-text box: the requester typed names from memory,
// the planner split them on commas, and anything mistyped became a group_missing blocker after
// the fact — or, far more often, the box was left empty and the hire got no groups at all.
//
// Listing the tenant's groups to choose from has one hazard the codebase already knows about:
// /groups pages, and a "list them all" that ignores @odata.nextLink silently truncates in a
// large tenant, reporting a perfectly real group as absent. So this pages, and when it hits its
// own ceiling it SAYS so rather than returning a short list that looks complete.
describe('listSelectableGroups', () => {
  function client(pages: any[]) {
    let i = 0;
    return { get: vi.fn(async () => pages[i++]) } as any;
  }

  it('follows @odata.nextLink to the end', async () => {
    const g = client([
      { value: [{ id: 'a', displayName: 'All Staff' }], '@odata.nextLink': 'https://graph.microsoft.us/v1.0/groups?$skiptoken=x' },
      { value: [{ id: 'b', displayName: 'Engineering' }] },
    ]);
    const out = await listSelectableGroups(g);
    expect(out.groups.map((x) => x.displayName)).toEqual(['All Staff', 'Engineering']);
    expect(out.truncated).toBe(false);
    expect(g.get).toHaveBeenCalledTimes(2);
  });

  // Graph REFUSES a manual add to a dynamic group, so offering one is offering a run that fails
  // at add_groups. Role-assignable groups stay: choosing one here is a deliberate act by someone
  // reading the list, unlike the mirror flow where they are copied sight-unseen.
  it('leaves out dynamic groups, which cannot be joined manually', async () => {
    const g = client([{ value: [
      { id: 'a', displayName: 'All Staff' },
      { id: 'b', displayName: 'Auto - Everyone', membershipRule: 'user.accountEnabled -eq true' },
      { id: 'c', displayName: 'Privileged Ops', isAssignableToRole: true },
    ] }]);
    const out = await listSelectableGroups(g);
    expect(out.groups.map((x) => x.displayName)).toEqual(['All Staff', 'Privileged Ops']);
  });

  it('says so when it stops at its own ceiling rather than looking complete', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({
      value: [{ id: `g${i}`, displayName: `Group ${i}` }],
      '@odata.nextLink': 'https://graph.microsoft.us/v1.0/groups?$skiptoken=x',
    }));
    const out = await listSelectableGroups(client(pages), { maxPages: 3 });
    expect(out.truncated).toBe(true);
    expect(out.groups).toHaveLength(3);
  });

  it('drops entries missing an id or a name — neither can be joined or matched', async () => {
    const g = client([{ value: [{ id: 'a' }, { displayName: 'No Id' }, { id: 'c', displayName: 'Fine' }] }]);
    expect((await listSelectableGroups(g)).groups).toEqual([{ id: 'c', displayName: 'Fine' }]);
  });
});
