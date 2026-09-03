import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sealSecret, openSecret, loadMasterKey } from '../src/integrations/entra/crypto.js';

const KEY_B64 = randomBytes(32).toString('base64');

describe('entra envelope crypto', () => {
  it('round-trips a secret', () => {
    const key = loadMasterKey(KEY_B64);
    const sealed = sealSecret('s3cr3t-value', key);
    expect(sealed.ciphertext).toBeInstanceOf(Buffer);
    expect(openSecret(sealed, key)).toBe('s3cr3t-value');
  });

  it('NEVER reuses an IV', () => {
    // The property that actually matters for AES-GCM: reusing an IV under the same key leaks the
    // keystream and destroys authenticity. A fixed or derived IV would pass every other test here
    // while being catastrophically broken, so this is the one to pin.
    const key = loadMasterKey(KEY_B64);
    const ivs = new Set(
      Array.from({ length: 200 }, () => sealSecret('same-plaintext', key).iv.toString('hex')),
    );
    expect(ivs.size).toBe(200);
  });

  it('produces different ciphertext for the same plaintext', () => {
    // Follows from the IV, but worth asserting directly: identical ciphertext across rows would
    // let anyone with database access see which customers share a secret.
    const key = loadMasterKey(KEY_B64);
    expect(sealSecret('abc', key).ciphertext.toString('hex'))
      .not.toBe(sealSecret('abc', key).ciphertext.toString('hex'));
  });

  it('does not leave the plaintext recoverable from the ciphertext', () => {
    const sealed = sealSecret('super-secret-client-value', loadMasterKey(KEY_B64));
    expect(sealed.ciphertext.toString('utf8')).not.toContain('super-secret');
    expect(sealed.ciphertext.toString('hex')).not.toContain(Buffer.from('super-secret').toString('hex'));
  });

  it('fails to open with the wrong key', () => {
    const sealed = sealSecret('abc', loadMasterKey(KEY_B64));
    const wrong = loadMasterKey(randomBytes(32).toString('base64'));
    expect(() => openSecret(sealed, wrong)).toThrow();
  });

  it('fails to open if the auth tag is tampered with', () => {
    const key = loadMasterKey(KEY_B64);
    const sealed = sealSecret('abc', key);
    sealed.tag[0] ^= 0xff;
    expect(() => openSecret(sealed, key)).toThrow();
  });

  it('fails to open if the CIPHERTEXT is tampered with', () => {
    // GCM authenticates the ciphertext too — a flipped bit there must be rejected, not silently
    // decrypted into garbage that then gets sent to Graph as a credential.
    const key = loadMasterKey(KEY_B64);
    const sealed = sealSecret('abcdefghijklmnop', key);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => openSecret(sealed, key)).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => loadMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('rejects an empty or missing master key with a message that says what to do', () => {
    // The likeliest real failure: INTEGRATION_ENC_KEY unset. "must decode to 32 bytes" beats a
    // crypto library's "Invalid key length".
    expect(() => loadMasterKey('')).toThrow(/32 bytes/);
  });

  it('records which key version sealed it, so a rotation can re-wrap', () => {
    expect(sealSecret('abc', loadMasterKey(KEY_B64)).keyVersion).toBe(1);
    expect(sealSecret('abc', loadMasterKey(KEY_B64), 2).keyVersion).toBe(2);
  });
});
