// AES-256-GCM envelope encryption for per-customer integration secrets.
//
// Key Vault is blocked by enclave policy in this environment, so the 32-byte master key is
// supplied through App Service config (INTEGRATION_ENC_KEY, base64) and only ciphertext, IV and
// auth tag are persisted. Decryption happens at sync or test time and nowhere else — nothing in
// the database is decryptable on its own.
//
// GCM's contract: a given (key, IV) pair must NEVER encrypt twice. Reusing one leaks the
// keystream and destroys authenticity, so the IV here is 12 random bytes per seal and must stay
// that way — a derived or fixed IV would pass a round-trip test while being catastrophically
// broken. There is a test that pins it.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** Which master key sealed this, so a rotation can find and re-wrap what it must. */
  keyVersion: number;
}

/** 96 bits, the GCM-recommended IV size — larger IVs get hashed and gain nothing. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function loadMasterKey(b64: string): Buffer {
  const key = Buffer.from(b64 ?? '', 'base64');
  if (key.length !== KEY_BYTES) {
    // Says what to do. The likeliest real failure is INTEGRATION_ENC_KEY simply being unset, and
    // "Invalid key length" from the crypto library does not help anyone diagnose that.
    throw new Error(
      `INTEGRATION_ENC_KEY must decode to 32 bytes (got ${key.length}); `
      + 'generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

export function sealSecret(plaintext: string, key: Buffer, keyVersion = 1): SealedSecret {
  const iv = randomBytes(IV_BYTES); // fresh per seal — see the header
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion };
}

/**
 * Throws on any tampering — wrong key, altered ciphertext, altered tag. That is the point: a
 * silently mis-decrypted secret would be sent to Graph as a credential and fail there instead,
 * which looks like a customer configuration problem rather than a data-integrity one.
 */
export function openSecret(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
