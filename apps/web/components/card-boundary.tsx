'use client';
// Contains a render error to the one card that threw. Without it, any exception in a ticket-page
// card (for instance an API response missing a field mid-deploy) replaced the WHOLE page with
// Next's "Application error: a client-side exception has occurred".
import * as React from 'react';

export class CardBoundary extends React.Component<{ name: string; children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}] failed to render`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm">
        <p className="font-medium text-danger">{this.props.name} could not be displayed.</p>
        <p className="mt-1 text-muted">The rest of the ticket is unaffected. Reload the page; if this keeps happening, report it to SBS IT.</p>
        <button type="button" className="mt-2 text-xs text-brand underline" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
