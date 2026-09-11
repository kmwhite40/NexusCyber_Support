import { describe, it, expect } from 'vitest';
import { partitionMirrorGroups } from '../src/integrations/m365/provisioning-graph.js';

const g = (over: Record<string, unknown>) => ({
  '@odata.type': '#microsoft.graph.group', id: 'g', displayName: 'G', ...over,
});

// "Copy access from (mirror user)" was on the form and read by nothing — someone filled it in
// believing access would be mirrored and nothing happened, which is worse than the field not
// existing. Wiring it to Entra means deciding what copying access may NOT copy.
describe('partitionMirrorGroups', () => {
  it('mirrors ordinary security groups and distribution lists', () => {
    const p = partitionMirrorGroups([
      g({ id: '1', displayName: 'DL-FED' }),
      g({ id: '2', displayName: 'Ember Hawk', groupTypes: ['Unified'] }),
    ]);
    expect(p.assignable.map((x) => x.displayName)).toEqual(['DL-FED', 'Ember Hawk']);
  });

  // Real: mike.rohan holds SBS_Dev_Users, isAssignableToRole=true. Copying it silently would hand
  // a new starter a group that can carry a directory role — approved by someone who read
  // "copy access from Mike", not the list of what Mike actually holds.
  it('separates role-assignable groups instead of copying them quietly', () => {
    const p = partitionMirrorGroups([
      g({ id: '1', displayName: 'DL-FED' }),
      g({ id: '2', displayName: 'SBS_Dev_Users', isAssignableToRole: true }),
    ]);
    expect(p.assignable.map((x) => x.displayName)).toEqual(['DL-FED']);
    expect(p.roleAssignable.map((x) => x.displayName)).toEqual(['SBS_Dev_Users']);
  });

  // Graph refuses a manual add to a dynamic group. Attempting it would fail the run at add_groups
  // for a reason that reads like a permissions problem.
  it('sets aside dynamic groups, which cannot take manual members', () => {
    const p = partitionMirrorGroups([g({ id: '1', displayName: 'Auto-All', membershipRule: 'user.department -eq "X"' })]);
    expect(p.assignable).toEqual([]);
    expect(p.dynamic.map((x) => x.displayName)).toEqual(['Auto-All']);
  });

  it('never treats a directory role as a group to copy', () => {
    const p = partitionMirrorGroups([
      { '@odata.type': '#microsoft.graph.directoryRole', id: 'r', displayName: 'Helpdesk Administrator' },
      g({ id: '1', displayName: 'DL-FED' }),
    ]);
    expect(p.assignable.map((x) => x.displayName)).toEqual(['DL-FED']);
    expect(p.directoryRoles.map((x) => x.displayName)).toEqual(['Helpdesk Administrator']);
  });

  it('handles a user who belongs to nothing', () => {
    const p = partitionMirrorGroups([]);
    expect(p).toEqual({ assignable: [], roleAssignable: [], dynamic: [], directoryRoles: [] });
  });
});
