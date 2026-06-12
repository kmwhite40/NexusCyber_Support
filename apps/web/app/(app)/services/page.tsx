'use client';
import React from 'react';
import { servicesApi, type ServiceRow, type ConfigurationItem } from '@/lib/api';

const CRITICALITY_LABEL: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
import { Card, CardBody, Badge } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton, StatCard } from '@/components/ui/data';

export default function ServicesPage() {
  const [tab, setTab] = React.useState<'services' | 'cis'>('services');
  const [services, setServices] = React.useState<ServiceRow[] | null>(null);
  const [cis, setCis] = React.useState<ConfigurationItem[] | null>(null);

  React.useEffect(() => {
    servicesApi.list().then(setServices).catch(() => setServices([]));
    servicesApi.cis().then(setCis).catch(() => setCis([]));
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Services &amp; assets</h1>
        <p className="mt-1 text-sm text-muted">Service registry and configuration items (CMDB).</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Services" value={services?.length ?? '—'} />
        <StatCard label="Configuration items" value={cis?.length ?? '—'} />
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => setTab('services')}
          className={`rounded-md px-3 py-1.5 text-sm ${tab === 'services' ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-surface-2'}`}
        >
          Services
        </button>
        <button
          onClick={() => setTab('cis')}
          className={`rounded-md px-3 py-1.5 text-sm ${tab === 'cis' ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-surface-2'}`}
        >
          Configuration items
        </button>
      </div>
      <Card>
        <CardBody>
          {tab === 'services' ? (
            services === null ? (
              <Skeleton className="h-12" />
            ) : (
              <DataTable<ServiceRow>
                rows={services}
                columns={[
                  { key: 'name', header: 'Service', render: (s) => s.name },
                  { key: 'kind', header: 'Kind', render: (s) => <Badge>{s.kind}</Badge> },
                  { key: 'ticket_count', header: 'Tickets', render: (s) => s.ticket_count },
                ]}
                empty={<EmptyState title="No services registered" />}
              />
            )
          ) : cis === null ? (
            <Skeleton className="h-12" />
          ) : (
            <DataTable<ConfigurationItem>
              rows={cis}
              columns={[
                { key: 'name', header: 'CI', render: (c) => c.name },
                { key: 'ci_class', header: 'Class', render: (c) => <Badge>{c.ci_class}</Badge> },
                { key: 'criticality', header: 'Criticality', render: (c) => CRITICALITY_LABEL[c.criticality] ?? String(c.criticality) },
                { key: 'status', header: 'Status', render: (c) => c.status },
                { key: 'ticket_count', header: 'Tickets', render: (c) => c.ticket_count },
              ]}
              empty={<EmptyState title="No configuration items" />}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
