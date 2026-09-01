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
  getCloudPcStatus,
  listGroupsByDisplayName,
} from '../src/integrations/m365/provisioning-graph.js';

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
  it('requests a single-use 8-hour temporary access pass', async () => {
    const post = vi.fn(async () => ({ id: 'tap1', temporaryAccessPass: 'abc' }));
    const g = { get: vi.fn(), post, patch: vi.fn() } as any;
    const out = await issueTap(g, 'u1');
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
