import { describe, it, expect, vi } from 'vitest';
import { enumerateManagedDevices } from '../src/integrations/entra/graph.js';

describe('enumerateManagedDevices', () => {
  it('follows @odata.nextLink and concatenates all pages', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': 'https://g/next' })
      .mockResolvedValueOnce({ value: [{ id: 'c' }] });
    const out = await enumerateManagedDevices({ get } as any);
    expect(out.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toContain('/deviceManagement/managedDevices');
    expect(get.mock.calls[1][0]).toBe('https://g/next');
  });

  it('asks for the fields the mapper reads', async () => {
    // Graph silently omits unselected fields. A short $select does not error — it returns
    // undefined, and every device would map with null serial, null compliance, null owner.
    // This is the same defect that hid in findUserByUpn until a review found it.
    const get = vi.fn(async () => ({ value: [] }));
    await enumerateManagedDevices({ get } as any);
    const url = decodeURIComponent(get.mock.calls[0][0]);
    for (const f of ['azureADDeviceId', 'deviceName', 'userPrincipalName', 'operatingSystem',
      'complianceState', 'serialNumber', 'managedDeviceOwnerType']) {
      expect(url).toContain(f);
    }
  });

  it('handles an empty tenant', async () => {
    expect(await enumerateManagedDevices({ get: vi.fn(async () => ({ value: [] })) } as any)).toEqual([]);
  });

  it('stops rather than looping forever on a self-referential nextLink', async () => {
    // A malformed or cyclic nextLink would otherwise spin until the process died, hammering
    // Graph the whole time.
    const get = vi.fn(async () => ({ value: [{ id: 'x' }], '@odata.nextLink': 'https://g/same' }));
    await expect(enumerateManagedDevices({ get } as any)).rejects.toThrow(/too many pages/i);
  });
});
