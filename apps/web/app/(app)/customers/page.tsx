'use client';
import React from 'react';
import { customersApi, type OrgSummary, type OrgDetail, type OrgUser } from '@/lib/api';
import { Card, CardBody } from '@/components/ui/primitives';
import { DataTable, EmptyState, Skeleton } from '@/components/ui/data';

export default function CustomersPage() {
  const [orgs, setOrgs] = React.useState<OrgSummary[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<OrgDetail | null>(null);
  const [detailErr, setDetailErr] = React.useState(false);
  const [users, setUsers] = React.useState<OrgUser[] | null>(null);

  React.useEffect(() => { customersApi.list().then(setOrgs).catch(() => setOrgs([])); }, []);

  function open(id: string) {
    setSelectedId(id); setDetail(null); setDetailErr(false); setUsers(null);
    customersApi.get(id).then(setDetail).catch(() => setDetailErr(true));
    customersApi.users(id).then(setUsers).catch(() => setUsers([]));
  }

  function close() {
    setSelectedId(null); setDetail(null); setDetailErr(false); setUsers(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <p className="mt-1 text-sm text-muted">Customer organizations and their users.</p>
      </div>
      <Card><CardBody>
        {orgs === null ? <Skeleton className="h-12" /> : (
          <DataTable<OrgSummary>
            rows={orgs}
            columns={[
              { key: 'name', header: 'Organization', render: (o) => <button className="text-brand hover:underline" onClick={() => open(o.id)}>{o.name}</button> },
              { key: 'cloud', header: 'Cloud', render: (o) => o.cloud ?? '—' },
            ]}
            empty={<EmptyState title="No customers" />}
          />
        )}
      </CardBody></Card>

      {selectedId && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={close}>
          <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <CardBody className="space-y-3">
              {detailErr ? (
                <p className="text-sm text-red-500">Failed to load organization.</p>
              ) : detail === null ? (
                <Skeleton className="h-12" />
              ) : (
                <>
                  <h2 className="text-lg font-semibold">{detail.name}</h2>
                  <div className="flex gap-6 text-sm text-muted">
                    <span>Cloud: <span className="text-fg">{detail.cloud}</span></span>
                    <span>Users: <span className="text-fg">{detail.user_count}</span></span>
                    <span>Open tickets: <span className="text-fg">{detail.open_tickets}</span></span>
                  </div>
                  {users === null ? <Skeleton className="h-10" /> : (
                    <DataTable<OrgUser>
                      rows={users}
                      columns={[
                        { key: 'email', header: 'Email', render: (u) => u.email },
                        { key: 'display_name', header: 'Name', render: (u) => u.display_name ?? '—' },
                        { key: 'status', header: 'Status', render: (u) => u.status },
                      ]}
                      empty={<EmptyState title="No users" />}
                    />
                  )}
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
