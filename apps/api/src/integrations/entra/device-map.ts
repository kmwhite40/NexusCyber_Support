// Pure mapping from Microsoft Graph Intune managedDevice records to CMDB CI fields, plus the
// retirement planner. No I/O, so every branch is testable without a tenant.

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

/** Intune-managed but not Entra-joined devices report all zeros here, not null. */
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Is this an employee's own device rather than the organisation's?
 *
 * Deliberately an allow-by-default test: ONLY an explicit 'personal' excludes. Intune reports
 * 'unknown' (and sometimes nothing at all) for records it cannot classify, and treating missing
 * data as personal would quietly drop corporate devices whose Intune record is incomplete —
 * silently shrinking a CMDB is the failure that is hardest to notice.
 */
export function isPersonalDevice(d: ManagedDevice): boolean {
  return (d.managedDeviceOwnerType ?? '').trim().toLowerCase() === 'personal';
}

export function mapManagedDevice(d: ManagedDevice): MappedCi | null {
  // Prefer the Entra device id; fall back to the Intune id. Treating the zero GUID as a real
  // value would collapse every non-Entra-joined device onto a single CI.
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
      // The field a physical audit actually matches on when someone hands a laptop back.
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

/**
 * IDs of currently-active synced CIs whose device no longer appears in the tenant.
 *
 * DANGER, and it belongs to the CALLER: this function cannot tell "the tenant genuinely has no
 * devices" from "enumeration failed halfway". Handed an empty seen-set it will retire every
 * synced CI in the organization. The orchestrator must therefore only call it after a FULLY
 * successful enumeration — see sync.ts, where that guard lives. There is a test pinning this
 * behaviour so the requirement stays visible from here too.
 */
export function planRetirements(seenExternalIds: Set<string>, existing: ExistingCi[]): string[] {
  return existing
    .filter((c) => c.status === 'active' && !seenExternalIds.has(c.external_id))
    .map((c) => c.id);
}
