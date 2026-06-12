// Shared helpers for k6 load tests against the Nexus API.
import http from 'k6/http';
import { check } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://host.docker.internal:4000/api/v1';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Dev-login (non-production) and return a bearer token. */
export function login(email) {
  const res = http.post(`${BASE}/auth/dev-login`, JSON.stringify({ email }), { headers: JSON_HEADERS });
  check(res, { 'login 200': (r) => r.status === 200 });
  return res.json('token');
}

export function authParams(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

/** A read-only journey an agent performs all day — used by smoke/load/soak. */
export function agentReadJourney(token) {
  const p = authParams(token);
  const batch = http.batch([
    ['GET', `${BASE}/me`, null, p],
    ['GET', `${BASE}/tickets?limit=25`, null, p],
    ['GET', `${BASE}/analytics/overview`, null, p],
    ['GET', `${BASE}/posture/findings`, null, p],
    ['GET', `${BASE}/oncall/schedules`, null, p],
    ['GET', `${BASE}/catalog`, null, p],
  ]);
  check(batch[0], { 'me 200': (r) => r.status === 200 });
  check(batch[1], { 'tickets 200': (r) => r.status === 200 });
  check(batch[2], { 'analytics 200': (r) => r.status === 200 });
  check(batch[3], { 'posture 200': (r) => r.status === 200 });
}
