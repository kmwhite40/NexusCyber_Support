// Storage + malware-scan adapters for attachments. The mock implementations are the
// dev/test default; production swaps a real object store (S3/Azure Blob) and AV
// (ClamAV/Defender) behind these same interfaces. (docs/nexus/08 §Q.3, US-013.)
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type UploadCheck = { ok: true } | { ok: false; reason: string };

/** Validate an upload's content type and size. Pure. */
export function validateUpload(meta: { contentType: string; size: number }): UploadCheck {
  if (!ALLOWED_CONTENT_TYPES.includes(meta.contentType)) {
    return { ok: false, reason: `disallowed content type: ${meta.contentType}` };
  }
  if (meta.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `file size ${meta.size} exceeds cap ${MAX_ATTACHMENT_BYTES}` };
  }
  return { ok: true };
}

export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Local-filesystem mock blob store (never serves bytes by URL — gov-egress-safe). */
export class LocalBlobStore implements BlobStore {
  constructor(private root = process.env.BLOB_DIR ?? join(tmpdir(), 'nexus-blobs')) {}
  private path(key: string) {
    return join(this.root, key);
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export type ScanResult = 'clean' | 'infected';

export interface MalwareScanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}

const EICAR = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

/** Mock scanner: flags the industry-standard EICAR test string; everything else clean. */
export class MockScanner implements MalwareScanner {
  async scan(bytes: Buffer): Promise<ScanResult> {
    return bytes.includes(EICAR) ? 'infected' : 'clean';
  }
}

// Default singletons used by the attachments module (swappable in tests/production).
export const blobStore: BlobStore = new LocalBlobStore();
export const scanner: MalwareScanner = new MockScanner();
