import { describe, it, expect } from 'vitest';
import { parseMentions, isValidRole } from '../src/modules/participants.js';

describe('parseMentions', () => {
  it('extracts @-mentioned emails, lowercased and deduped', () => {
    const text = 'cc @Alex@acme.example.com and @security@acme.example.com — also @ALEX@acme.example.com';
    expect(parseMentions(text)).toEqual(['alex@acme.example.com', 'security@acme.example.com']);
  });
  it('does not treat a bare email (no @ mention marker) as a mention', () => {
    expect(parseMentions('a normal comment that includes an address alex@acme.example.com inline')).toEqual([]);
  });
  it('ignores stray @ characters', () => {
    expect(parseMentions('email me @ the office tomorrow')).toEqual([]);
  });
});

describe('isValidRole', () => {
  it('accepts the three participant roles', () => {
    expect(isValidRole('watcher')).toBe(true);
    expect(isValidRole('collaborator')).toBe(true);
    expect(isValidRole('approver')).toBe(true);
  });
  it('rejects unknown roles', () => {
    expect(isValidRole('admin')).toBe(false);
  });
});
