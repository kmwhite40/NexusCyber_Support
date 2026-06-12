'use client';
import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-context';
import { Card, CardBody } from '@/components/ui/primitives';

const LINKS: { href: string; title: string; body: string }[] = [
  { href: '/tickets/new', title: 'Create a ticket', body: 'Log an incident or service request.' },
  { href: '/catalog', title: 'Browse the service catalog', body: 'Request a service from the catalog.' },
  { href: '/queues', title: 'Work your queues', body: 'See tickets assigned to your team.' },
  { href: '/kb', title: 'Knowledge base', body: 'Find and write help articles.' },
  { href: '/oncall', title: 'On-call & alerts', body: 'Check rotations and respond to alerts.' },
  { href: '/dashboards', title: 'Dashboards', body: 'Build a named operations dashboard.' },
];

export default function GetStartedPage() {
  const { me } = useAuth();
  const first = me?.email?.split('@')[0] ?? 'there';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get started</h1>
        <p className="mt-1 text-sm text-muted">Welcome, {first}. Jump into the most common tasks.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            <Card className="h-full transition-transform hover:-translate-y-0.5">
              <CardBody>
                <h3 className="text-sm font-semibold text-fg">{l.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{l.body}</p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
