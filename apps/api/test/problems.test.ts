import { describe, it, expect } from 'vitest';
import { canTransition, clusterIncidents } from '../src/modules/problems.js';

describe('canTransition (problem lifecycle)', () => {
  it('allows open -> investigating -> known_error -> resolved -> closed', () => {
    expect(canTransition('open', 'investigating')).toBe(true);
    expect(canTransition('investigating', 'known_error')).toBe(true);
    expect(canTransition('known_error', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'closed')).toBe(true);
  });
  it('rejects illegal jumps', () => {
    expect(canTransition('open', 'resolved')).toBe(false);
    expect(canTransition('closed', 'open')).toBe(false);
  });
});

describe('clusterIncidents', () => {
  const incidents = [
    { id: '1', category: 'VPN', subject: 'VPN drops' },
    { id: '2', category: 'vpn', subject: 'VPN slow' },
    { id: '3', category: 'VPN', subject: 'VPN no connect' },
    { id: '4', category: 'Email', subject: 'cannot send' },
  ];
  it('clusters by category (case-insensitive) above the threshold', () => {
    const clusters = clusterIncidents(incidents, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBe('vpn');
    expect(clusters[0].count).toBe(3);
    expect(clusters[0].ticketIds).toEqual(['1', '2', '3']);
  });
  it('returns nothing when no category meets the threshold', () => {
    expect(clusterIncidents(incidents, 5)).toEqual([]);
  });
  it('buckets null categories as uncategorized', () => {
    const c = clusterIncidents([
      { id: 'a', category: null, subject: 'x' },
      { id: 'b', category: null, subject: 'y' },
    ], 2);
    expect(c[0].key).toBe('uncategorized');
  });
});
