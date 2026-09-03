import { describe, it, expect } from 'vitest';
import {
  parseApiKey,
  formatApiKey,
  sanitizeScopes,
  looksLikeApiKey,
  buildKeyPrincipal,
  DEFAULT_KEY_SCOPES,
} from '../src/auth/api-key.js';
import { signWebhook, isSafeWebhookUrl, WEBHOOK_EVENTS } from '../src/modules/webhooks.js';

describe('API key token format', () => {
  it('round-trips keyId + secret', () => {
    const token = formatApiKey('abc123', 'deadbeefcafe');
    expect(token).toBe('ak_abc123_deadbeefcafe');
    expect(parseApiKey(token)).toEqual({ keyId: 'abc123', secret: 'deadbeefcafe' });
  });

  it('splits only on the first underscore so a separator in the secret survives', () => {
    expect(parseApiKey('ak_key_sec_ret')).toEqual({ keyId: 'key', secret: 'sec_ret' });
  });

  it('rejects non-key tokens', () => {
    expect(parseApiKey('Bearer xyz')).toBeNull();
    expect(parseApiKey('ak_')).toBeNull();
    expect(parseApiKey('ak__nokey')).toBeNull();
    expect(parseApiKey('ak_onlyid_')).toBeNull();
  });

  it('classifies a bearer value as an API key vs JWT', () => {
    expect(looksLikeApiKey('ak_abc_def')).toBe(true);
    expect(looksLikeApiKey('eyJhbGc.payload.sig')).toBe(false);
    expect(looksLikeApiKey(undefined)).toBe(false);
  });
});

describe('API key scopes', () => {
  it('falls back to defaults when empty or fully invalid', () => {
    expect(sanitizeScopes()).toEqual(DEFAULT_KEY_SCOPES);
    expect(sanitizeScopes([])).toEqual(DEFAULT_KEY_SCOPES);
    expect(sanitizeScopes(['admin.superuser', 'billing.manage'])).toEqual(DEFAULT_KEY_SCOPES);
  });

  it('keeps only allow-listed verbs and dedupes', () => {
    expect(sanitizeScopes(['ticket.create', 'ticket.create', 'admin.superuser'])).toEqual(['ticket.create']);
  });

  it('never lets a key hold privileged verbs', () => {
    expect(sanitizeScopes(['admin.superuser'])).not.toContain('admin.superuser');
  });
});

describe('API key principal', () => {
  it('is a nexus-plane identity scoped to exactly one org', () => {
    const p = buildKeyPrincipal({
      id: 'k1', organization_id: 'org-1', key_id: 'kid', key_hash: 'h',
      name: 'Anchor', scopes: ['ticket.create'], expires_at: null, revoked_at: null,
    });
    expect(p.plane).toBe('nexus');
    expect(p.organizationId).toBeNull();
    expect(p.assignedOrgs).toEqual(['org-1']);
    expect(p.allOrgs).toBe(false);
    expect(p.permissions).toEqual(['ticket.create']);
  });
});

describe('webhook HMAC signature', () => {
  it('is deterministic and key-dependent', () => {
    const body = JSON.stringify({ type: 'ticket.resolved', id: 't1' });
    const a = signWebhook('secret-a', body);
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhook('secret-a', body)).toBe(a); // stable
    expect(signWebhook('secret-b', body)).not.toBe(a); // keyed
  });

  it('changes when the body changes', () => {
    expect(signWebhook('s', '{"a":1}')).not.toBe(signWebhook('s', '{"a":2}'));
  });
});

describe('webhook URL SSRF guard', () => {
  it('allows a public https endpoint', () => {
    expect(isSafeWebhookUrl('https://hooks.example.com/anchor')).toBe(true);
  });

  it('requires https when http is not allowed', () => {
    expect(isSafeWebhookUrl('http://hooks.example.com', { allowHttp: false })).toBe(false);
    expect(isSafeWebhookUrl('https://hooks.example.com', { allowHttp: false })).toBe(true);
  });

  it('blocks loopback, private, and link-local/metadata targets', () => {
    for (const url of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://172.16.9.9/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data', // cloud metadata
      'https://[::1]/x',
      'https://metadata.google.internal/x',
    ]) {
      expect(isSafeWebhookUrl(url), url).toBe(false);
    }
  });

  it('rejects malformed and non-http schemes', () => {
    expect(isSafeWebhookUrl('not a url')).toBe(false);
    expect(isSafeWebhookUrl('ftp://example.com')).toBe(false);
  });
});

describe('webhook event catalog', () => {
  it('covers the ticket lifecycle used for writeback', () => {
    expect(WEBHOOK_EVENTS).toContain('ticket.status_changed');
    expect(WEBHOOK_EVENTS).toContain('ticket.resolved');
    expect(WEBHOOK_EVENTS).toContain('ticket.closed');
  });
});
