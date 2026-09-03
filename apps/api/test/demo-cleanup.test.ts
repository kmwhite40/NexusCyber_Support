import { describe, it, expect } from 'vitest';
import {
  DEMO_EMAIL_PREDICATE, SELECT_AFFECTED, DELETE_ROLE_ASSIGNMENTS, SUSPEND_ACCOUNTS,
} from '../src/modules/demo-cleanup.js';

// The statements an operator runs against production. Pinned because they are destructive-ish
// and run outside the normal review path — a script is easier to change carelessly than a module.
describe('demo cleanup statements', () => {
  it('matches only the three seeded demo domains', () => {
    for (const d of ['@demo.example.com', '@nexus.example.com', '@anchor.example']) {
      expect(DEMO_EMAIL_PREDICATE).toContain(d);
    }
    // sbsfederal.com is the REAL domain. Matching it would stand down the actual staff.
    expect(DEMO_EMAIL_PREDICATE).not.toContain('sbsfederal');
  });

  it('never deletes a user', () => {
    // The whole point of this approach: these accounts author live content and the FKs are
    // ON DELETE NO ACTION. A DELETE FROM users here would either fail or destroy provenance.
    for (const sql of [SELECT_AFFECTED, DELETE_ROLE_ASSIGNMENTS, SUSPEND_ACCOUNTS]) {
      expect(sql).not.toMatch(/DELETE\s+FROM\s+users/i);
    }
  });

  it('removes role assignments, which is what a permission audit reads', () => {
    expect(DELETE_ROLE_ASSIGNMENTS).toMatch(/DELETE\s+FROM\s+role_assignments/i);
  });

  it('suspends rather than leaving status alone', () => {
    expect(SUSPEND_ACCOUNTS).toMatch(/status\s*=\s*'suspended'/);
  });

  it('is idempotent — re-running suspends nothing already suspended', () => {
    expect(SUSPEND_ACCOUNTS).toMatch(/status\s*<>\s*'suspended'/);
  });

  it('touches no other table', () => {
    const all = [SELECT_AFFECTED, DELETE_ROLE_ASSIGNMENTS, SUSPEND_ACCOUNTS].join(' ');
    for (const t of ['kb_pages', 'queues', 'automation_rules', 'escalation_policies', 'tickets', 'organizations']) {
      expect(all).not.toContain(t);
    }
  });
});
