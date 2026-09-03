'use client';
// Service catalog — the in-scope helpdesk request types as guided, workflow-backed
// requests (docs/nexus/workflows/service-desk-workflows.md).
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { api, catalog, users, attachmentsApi, type CatalogItem, type Ticket, type CatalogForm, type FormFieldDef, ApiError } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { UserPicker } from '@/components/user-picker';
import { DynamicFormField, isFieldVisible } from '@/components/dynamic-form-field';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge } from '@/components/ui/primitives';
import { RequestModal } from '@/components/catalog-request-modal';
import { Skeleton } from '@/components/ui/data';
import { Clock } from 'lucide-react';

export default function CatalogPage() {
  const router = useRouter();
  const { me } = useAuth();
  const [items, setItems] = React.useState<CatalogItem[] | null>(null);
  const [active, setActive] = React.useState<CatalogItem | null>(null);
  const [orgs, setOrgs] = React.useState<Array<{ id: string; name: string }>>([]);

  React.useEffect(() => {
    catalog.list().then((r) => setItems(r.data)).catch(() => setItems([]));
    if (me?.plane === 'nexus') {
      api.get<{ data: Array<{ id: string; name: string }> }>('/organizations').then((r) => setOrgs(r.data)).catch(() => {});
    }
  }, [me]);

  // Deep-link support: /catalog?item=<key> (e.g. from the portal search) opens that
  // item's request form directly instead of landing on the full catalog.
  React.useEffect(() => {
    if (!items || items.length === 0) return;
    const key = new URLSearchParams(window.location.search).get('item');
    if (!key) return;
    const match = items.find((i) => i.key === key);
    if (match) setActive(match);
  }, [items]);

  const grouped = (items ?? []).reduce<Record<string, CatalogItem[]>>((acc, it) => {
    (acc[it.category] ??= []).push(it);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Service catalog</h1>
        <p className="mt-1 text-sm text-muted">
          Request a standard service. We&rsquo;ll take care of the rest and keep you updated, asking
          for approval where it&rsquo;s needed.
        </p>
      </div>

      {!items ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : (
        Object.entries(grouped).map(([category, list]) => (
          <div key={category}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{category}</h2>
              <span className="text-xs text-muted">({list.length})</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((it) => (
                <Card key={it.key} className="flex h-full flex-col transition-transform hover:-translate-y-1">
                  <CardBody className="flex flex-1 flex-col">
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-fg">{it.name}</h3>
                      {it.requires_approval && <Badge tone="warning">Needs approval</Badge>}
                    </div>
                    <p className="flex-1 text-xs leading-relaxed text-muted">
                      {it.description ?? 'Submit this request and our team will handle it for you.'}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                        <Clock className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                        Typically done in {Math.round(it.sla_resolution_min / 60)}h
                      </span>
                      <Button size="sm" onClick={() => setActive(it)}>Request</Button>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}

      {active && (
        <RequestModal
          item={active}
          orgs={orgs}
          isAgent={me?.plane === 'nexus'}
          onClose={() => setActive(null)}
          onCreated={(t) => router.push(`/tickets/${t.id}`)}
        />
      )}
    </div>
  );
}

// Provider name (form_fields.options_source) -> the endpoint that lists its choices.
// Seeded providers: `cloudpc_policies` (0054). Add a row here when a new provider is seeded.
