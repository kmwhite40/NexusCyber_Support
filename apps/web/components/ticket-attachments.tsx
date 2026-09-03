'use client';
import * as React from 'react';
import { attachmentsApi, ApiError, type Attachment } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardBody, Button, Badge } from '@/components/ui/primitives';

// Ticket attachments — upload + list + download for both agents and customers.
// The API enforces org-scope, the allowed-type allowlist, a 10 MB cap, and AV
// scanning (downloads of non-clean files are blocked server-side).
const MAX_MB = 10;
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.txt,.json,.zip,.docx,.xlsx,application/pdf,image/png,image/jpeg,image/gif,text/plain,application/json,application/zip';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ScanBadge({ status }: { status: string }) {
  if (status === 'clean') return <Badge tone="success">clean</Badge>;
  if (status === 'infected') return <Badge tone="danger">infected</Badge>;
  return <Badge tone="warning">{status || 'pending'}</Badge>;
}

export function TicketAttachments({ ticketId }: { ticketId: string }) {
  const [items, setItems] = React.useState<Attachment[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(() => {
    attachmentsApi.list(ticketId).then((r) => setItems(r.data)).catch(() => setItems([]));
  }, [ticketId]);
  React.useEffect(() => load(), [load]);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      await attachmentsApi.upload(ticketId, file);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function download(a: Attachment) {
    setError(null);
    try {
      await attachmentsApi.download(a.id, a.filename);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : 'Download failed');
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Attachments</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        {items === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">No files attached yet.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-md border border-border bg-surface-2/40 p-2">
                <span className="truncate text-sm text-fg" title={a.filename}>{a.filename}</span>
                <span className="text-xs text-muted">{humanSize(a.size_bytes)}</span>
                <ScanBadge status={a.scan_status} />
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={a.scan_status !== 'clean'}
                  onClick={() => download(a)}
                  title={a.scan_status !== 'clean' ? 'Download blocked until the file passes scanning' : 'Download'}
                >
                  Download
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div
          className="rounded-md border border-dashed border-border p-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
            className="text-sm text-muted"
          />
          <p className="mt-1 text-[11px] text-muted">
            {busy ? 'Uploading…' : `Drag & drop or browse. PDF, images, TXT, JSON, ZIP, DOCX, XLSX up to ${MAX_MB} MB.`}
          </p>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}
