import { describe, it, expect } from 'vitest';
import {
  issueSurveyToken, hashSurveyToken, isValidScore, surveyIsAnswerable, SURVEY_QUESTIONS,
} from '../src/modules/csat.js';

// The survey link answers on the requester's behalf with no login, so the token IS a credential.
// Everything below is about it behaving like one.
describe('the public survey token', () => {
  it('is long enough that guessing is not a strategy', () => {
    const { token } = issueSurveyToken();
    // 32 random bytes in base64url. Anything shorter is enumerable by someone with a script and
    // patience, and a hit rates a real ticket as someone else.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => issueSurveyToken().token));
    expect(seen.size).toBe(200);
  });

  // Only the hash is stored. A database read — a backup, an export, a replica someone got at —
  // must not yield working links.
  it('hands back a hash to store, not the token', () => {
    const { token, tokenHash } = issueSurveyToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(hashSurveyToken(token)).toBe(tokenHash);
  });

  it('hashes deterministically so a presented token can be looked up', () => {
    expect(hashSurveyToken('abc')).toBe(hashSurveyToken('abc'));
    expect(hashSurveyToken('abc')).not.toBe(hashSurveyToken('abd'));
  });
});

// Three states look the same to someone clicking a link, and telling them apart is the whole
// difference between "it's broken" and "you already did this".
describe('surveyIsAnswerable', () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);

  it('accepts an unanswered, unexpired survey', () => {
    expect(surveyIsAnswerable({ responded_at: null, expires_at: future })).toEqual({ ok: true });
  });

  it('refuses one that was already answered, and says so', () => {
    const r = surveyIsAnswerable({ responded_at: past, expires_at: future });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('answered');
  });

  it('refuses an expired link, and says so', () => {
    const r = surveyIsAnswerable({ responded_at: null, expires_at: past });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('expired');
  });

  // Answered wins: a link that is both stale and already used should tell the person the useful
  // thing, which is that their rating landed.
  it('reports an answered survey as answered even once it has expired', () => {
    expect(surveyIsAnswerable({ responded_at: past, expires_at: past }).reason).toBe('answered');
  });

  // Rows created before this migration have no expiry. They are old, not eternal.
  it('treats a missing expiry as expired rather than as forever', () => {
    expect(surveyIsAnswerable({ responded_at: null, expires_at: null }).reason).toBe('expired');
  });
});

describe('the questions', () => {
  it('asks exactly three, each rated one to five', () => {
    expect(SURVEY_QUESTIONS).toHaveLength(3);
    for (const q of SURVEY_QUESTIONS) {
      expect(q.key).toMatch(/^(overall|timeliness|technician)$/);
      expect(q.label.length).toBeGreaterThan(10);
    }
  });

  // The overall score is the one that flows to tickets.satisfaction_score and every existing
  // report, so it has to stay first and stay identifiable.
  it('puts overall satisfaction first, since that is the score every report already uses', () => {
    expect(SURVEY_QUESTIONS[0].key).toBe('overall');
  });
});

describe('isValidScore', () => {
  it('takes the integers one to five and nothing else', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(isValidScore(n)).toBe(true);
    for (const n of [0, 6, -1, 2.5, '3', null, undefined, NaN]) expect(isValidScore(n)).toBe(false);
  });
});

// Analytics: the three scores, and who actually worked the ticket.
import { summarizeSurveys, csatByAgent } from '../src/modules/csat.js';

describe('summarizeSurveys', () => {
  const rows = [
    { score: 5, score_timeliness: 4, score_technician: 5, responded_at: new Date() },
    { score: 3, score_timeliness: 2, score_technician: 4, responded_at: new Date() },
    { score: null, score_timeliness: null, score_technician: null, responded_at: null },
  ];

  it('averages each question separately', () => {
    const m = summarizeSurveys(rows);
    expect(m.avg_overall).toBe(4);
    expect(m.avg_timeliness).toBe(3);
    expect(m.avg_technician).toBe(4.5);
  });

  it('reports the response rate against everything sent', () => {
    const m = summarizeSurveys(rows);
    expect(m.sent).toBe(3);
    expect(m.responded).toBe(2);
    expect(m.response_rate_pct).toBe(67);
  });

  // An average over nothing is not zero — zero is the worst possible rating, and showing it on a
  // dashboard reads as "our customers hate us" when the truth is "nobody has answered yet".
  it('returns null, not zero, when nobody has answered', () => {
    const m = summarizeSurveys([{ score: null, score_timeliness: null, score_technician: null, responded_at: null }]);
    expect(m.avg_overall).toBeNull();
    expect(m.avg_timeliness).toBeNull();
    expect(m.response_rate_pct).toBe(0);
  });

  it('handles an empty set without inventing anything', () => {
    expect(summarizeSurveys([])).toEqual({
      sent: 0, responded: 0, response_rate_pct: 0,
      avg_overall: null, avg_timeliness: null, avg_technician: null,
    });
  });

  // Surveys answered before the extra questions existed have only an overall score. They must
  // still count towards overall rather than being dropped for lacking the other two.
  it('still counts a legacy response that only has an overall score', () => {
    const m = summarizeSurveys([{ score: 4, score_timeliness: null, score_technician: null, responded_at: new Date() }]);
    expect(m.avg_overall).toBe(4);
    expect(m.avg_timeliness).toBeNull();
    expect(m.responded).toBe(1);
  });
});

// Attribution is frozen at resolve time on the survey row. tickets.assigned_agent_id is mutable
// and has no history, so crediting whoever holds a ticket TODAY silently rewrites past
// performance every time an old ticket is reassigned.
describe('csatByAgent', () => {
  const rows = [
    { agent_id: 'a1', agent_name: 'Rivera, Sam', score: 5, score_timeliness: 5, score_technician: 5, responded_at: new Date() },
    { agent_id: 'a1', agent_name: 'Rivera, Sam', score: 3, score_timeliness: 3, score_technician: 3, responded_at: new Date() },
    { agent_id: 'a2', agent_name: 'Okafor, Ada', score: 4, score_timeliness: 4, score_technician: 4, responded_at: new Date() },
    { agent_id: 'a2', agent_name: 'Okafor, Ada', score: null, score_timeliness: null, score_technician: null, responded_at: null },
  ];

  it('groups the responses by the agent frozen on the survey', () => {
    const out = csatByAgent(rows);
    expect(out.map((a) => a.agentId).sort()).toEqual(['a1', 'a2']);
    expect(out.find((a) => a.agentId === 'a1')!.avg_overall).toBe(4);
    expect(out.find((a) => a.agentId === 'a1')!.responded).toBe(2);
  });

  it('counts what was sent to an agent as well as what came back', () => {
    const a2 = csatByAgent(rows).find((a) => a.agentId === 'a2')!;
    expect(a2.sent).toBe(2);
    expect(a2.responded).toBe(1);
    expect(a2.response_rate_pct).toBe(50);
  });

  // A survey from before the snapshot existed has no agent. Bucketing those under a single
  // "unknown" agent would invent a technician and rank them.
  it('leaves out surveys with nobody attributed rather than inventing one', () => {
    const out = csatByAgent([{ agent_id: null, agent_name: null, score: 5, score_timeliness: 5, score_technician: 5, responded_at: new Date() }]);
    expect(out).toEqual([]);
  });

  it('ranks the best first so the list reads as a leaderboard', () => {
    const out = csatByAgent([
      ...rows,
      { agent_id: 'a3', agent_name: 'Best, Ever', score: 5, score_timeliness: 5, score_technician: 5, responded_at: new Date() },
      { agent_id: 'a4', agent_name: 'Rough, Week', score: 1, score_timeliness: 1, score_technician: 1, responded_at: new Date() },
    ]);
    expect(out[0].agentId).toBe('a3');
    expect(out[out.length - 1].agentId).toBe('a4');
  });

  // An agent who has been sent surveys but has no answers yet sorts LAST, not top. Treating "no
  // data" as a perfect score would put them above people with real ratings.
  it('does not let an agent with no responses outrank one with real ratings', () => {
    const out = csatByAgent([
      { agent_id: 'rated', agent_name: 'Has, Ratings', score: 2, score_timeliness: 2, score_technician: 2, responded_at: new Date() },
      { agent_id: 'silent', agent_name: 'No, Answers', score: null, score_timeliness: null, score_technician: null, responded_at: null },
    ]);
    expect(out[0].agentId).toBe('rated');
    expect(out[1].avg_overall).toBeNull();
  });
});
