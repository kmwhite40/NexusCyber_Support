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

  it('falls back to the Intune id when azureADDeviceId is the zero GUID', () => {
    // Devices that are Intune-managed but not Entra-joined report all zeros. Keying on that
    // would collapse every such device onto one CI.
    const m = mapManagedDevice({ azureADDeviceId: '00000000-0000-0000-0000-000000000000', id: 'intune-9', deviceName: 'X' });
    expect(m!.externalId).toBe('intune-9');
  });

  it('returns null when no usable id exists', () => {
    expect(mapManagedDevice({ deviceName: 'orphan' })).toBeNull();
  });

  it('uses externalId as the name when deviceName is missing', () => {
    expect(mapManagedDevice({ azureADDeviceId: 'aad-2' })!.name).toBe('aad-2');
  });

  it('keeps the serial number, which is what a physical audit matches on', () => {
    const m = mapManagedDevice({ azureADDeviceId: 'aad-3', serialNumber: 'SN-XYZ' });
    expect(m!.attributes.serialNumber).toBe('SN-XYZ');
  });
});

describe('planRetirements', () => {
  it('retires active synced CIs whose device is gone, ignoring already-retired ones', () => {
    const existing = [
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-2', external_id: 'aad-2', status: 'active' },
      { id: 'ci-3', external_id: 'aad-3', status: 'retired' },
    ];
    expect(planRetirements(new Set(['aad-1']), existing)).toEqual(['ci-2']);
  });

  it('would retire EVERYTHING on an empty seen-set — the caller must never call it that way', () => {
    // Documented rather than defended here, because the planner cannot tell "the tenant genuinely
    // has no devices" from "enumeration failed halfway". The orchestrator is what must refuse to
    // retire after anything less than a fully successful enumeration; this test exists so that
    // requirement is visible from the planner too, and so nobody 'simplifies' the guard away.
    const existing = [
      { id: 'ci-1', external_id: 'aad-1', status: 'active' },
      { id: 'ci-2', external_id: 'aad-2', status: 'active' },
    ];
    expect(planRetirements(new Set(), existing)).toEqual(['ci-1', 'ci-2']);
  });

  it('retires nothing when every device is still present', () => {
    const existing = [{ id: 'ci-1', external_id: 'aad-1', status: 'active' }];
    expect(planRetirements(new Set(['aad-1']), existing)).toEqual([]);
  });
});
