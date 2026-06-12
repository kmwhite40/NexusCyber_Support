import * as React from 'react';
import Link from 'next/link';
import { BrandMark } from '@/components/ui/brand';

/** Shared chrome for public legal pages (Terms, Privacy): brand header, prose container, footer. */
export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="text-lg font-semibold">Anchor</span>
          </Link>
          <Link href="/login" className="text-sm text-muted transition hover:text-fg">
            Sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">Last updated: {updated}</p>
        <article className="mt-8 space-y-7 text-sm leading-relaxed text-fg/90 [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-fg [&_li]:ms-5 [&_li]:list-disc [&_p]:mt-2">
          {children}
        </article>
        <div className="mt-10 flex gap-4 text-sm">
          <Link href="/terms" className="text-brand hover:underline">
            Terms of Service
          </Link>
          <Link href="/privacy" className="text-brand hover:underline">
            Privacy Policy
          </Link>
        </div>
        <footer className="mt-12 border-t border-border pt-6 text-xs text-muted">
          Copyright © 2026 NexusCyber. Operated as part of Strategic Business Systems, Inc. All
          rights reserved.
        </footer>
      </main>
    </div>
  );
}

/** A titled section within a legal document. */
export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2>{heading}</h2>
      {children}
    </section>
  );
}
