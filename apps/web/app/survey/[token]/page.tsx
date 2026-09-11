'use client';
// The public satisfaction survey.
//
// Deliberately outside the (app) group, so it renders without the AppShell and without the
// client-side auth gate that redirects a signed-out visitor to /login. That gate is the entire
// reason this page exists: the invite used to link to /tickets/{id}, which an end user could only
// open after authenticating, and a survey you have to log in to answer is a survey most people
// never answer.
//
// Authorization is the token in the URL. It is a credential — 256 bits, stored only as a hash,
// single-use, expiring — so this page shows the bare minimum: the ticket number and the
// questions. A survey link can be forwarded or sit in a shared mailbox, and whoever ends up
// holding it should learn nothing about the ticket beyond the number they can already see.
import * as React from 'react';
import { API_BASE } from '@/lib/api';
import { StarRating } from '@/components/star-rating';
import { Button, Textarea } from '@/components/ui/primitives';

type Question = { key: 'overall' | 'timeliness' | 'technician'; label: string };
type State = 'loading' | 'ok' | 'answered' | 'expired' | 'unknown' | 'sent' | 'error';

export default function SurveyPage({ params }: { params: { token: string } }) {
  const token = params.token;
  const [state, setState] = React.useState<State>('loading');
  const [ticketNumber, setTicketNumber] = React.useState<string | null>(null);
  const [questions, setQuestions] = React.useState<Question[]>([]);
  const [scores, setScores] = React.useState<Record<string, number>>({});
  const [comment, setComment] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    fetch(`${API_BASE}/csat/r/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((r) => {
        setState(r.state ?? 'unknown');
        setTicketNumber(r.ticketNumber ?? null);
        setQuestions(r.questions ?? []);
      })
      .catch(() => setState('error'));
  }, [token]);

  const allAnswered = questions.length > 0 && questions.every((q) => scores[q.key]);

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/csat/r/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overall: scores.overall, timeliness: scores.timeliness, technician: scores.technician,
          comment: comment.trim() || undefined,
        }),
      });
      const r = await res.json().catch(() => ({}));
      setState(res.ok && r.state === 'ok' ? 'sent' : (r.state ?? 'error'));
    } catch {
      setState('error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-12">
      <h1 className="text-2xl font-semibold text-fg">How did we do?</h1>
      {ticketNumber && <p className="mt-1 text-sm text-muted">Ticket {ticketNumber}</p>}

      {state === 'loading' && <p className="mt-6 text-sm text-muted">Loading your survey…</p>}

      {/* Every dead end says which one it is. "Nothing happened" is the state that makes someone
          conclude the system is broken and give up — see the people picker, twice. */}
      {state === 'answered' && (
        <p className="mt-6 text-sm text-fg">
          Thank you — this survey has already been answered. There is nothing more to do.
        </p>
      )}
      {state === 'expired' && (
        <p className="mt-6 text-sm text-fg">
          This survey link has expired. Links stay open for 30 days after a ticket is resolved.
          If you would still like to give feedback, reply to the email about your ticket and it
          will reach the team.
        </p>
      )}
      {state === 'unknown' && (
        <p className="mt-6 text-sm text-fg">
          We could not find a survey for this link. It may have been mistyped or truncated by an
          email client — try opening it directly from the original message.
        </p>
      )}
      {state === 'error' && (
        <p className="mt-6 text-sm text-danger">
          Something went wrong reaching the survey. Please try again in a moment.
        </p>
      )}
      {state === 'sent' && (
        <div className="mt-6">
          <p className="text-sm text-fg">Thank you — your feedback has been recorded.</p>
          <p className="mt-2 text-sm text-muted">It goes straight to the team who worked on your request.</p>
        </div>
      )}

      {state === 'ok' && (
        <div className="mt-8 space-y-7">
          {questions.map((q) => (
            <StarRating
              key={q.key}
              label={q.label}
              value={scores[q.key] ?? null}
              onChange={(v) => setScores((s) => ({ ...s, [q.key]: v }))}
            />
          ))}
          <div>
            <label htmlFor="csat-comment" className="mb-2 block text-sm font-medium text-fg">
              Anything else you would like us to know? (optional)
            </label>
            <Textarea id="csat-comment" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={submit} disabled={!allAnswered || submitting}>
              {submitting ? 'Sending…' : 'Send feedback'}
            </Button>
            {/* Says WHY the button is disabled. A disabled control with no explanation is the
                same dead end as a blank page. */}
            {!allAnswered && (
              <span className="text-xs text-muted">Please rate all three questions.</span>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
