import { describe, it, expect } from 'vitest';
import { validateUpload, MockScanner, ALLOWED_CONTENT_TYPES } from '../src/modules/storage.js';

describe('validateUpload', () => {
  it('accepts an allowed type within the size cap', () => {
    expect(validateUpload({ contentType: 'application/pdf', size: 1000 })).toEqual({ ok: true });
  });
  it('rejects a disallowed content type', () => {
    const r = validateUpload({ contentType: 'application/x-msdownload', size: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/content type/i);
  });
  it('rejects an oversized file', () => {
    const r = validateUpload({ contentType: 'application/pdf', size: 11 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/size/i);
  });
  it('exposes a non-empty allow-list', () => {
    expect(ALLOWED_CONTENT_TYPES.length).toBeGreaterThan(0);
  });
});

describe('MockScanner', () => {
  it('flags the EICAR test string as infected', async () => {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    expect(await new MockScanner().scan(Buffer.from(eicar))).toBe('infected');
  });
  it('treats normal content as clean', async () => {
    expect(await new MockScanner().scan(Buffer.from('hello world'))).toBe('clean');
  });
});
