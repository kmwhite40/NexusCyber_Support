'use client';
import { AppShell } from '@/components/shell';
import { DemoToggle } from '@/components/demo-toggle';

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      {children}
      <DemoToggle />
    </AppShell>
  );
}
