// Smoke test — minimal load, strict correctness. Run after every deploy.
//   k6 run load/smoke.js   (or via Docker, see load/README.md)
import { sleep } from 'k6';
import { login, agentReadJourney } from './helper.js';

export const options = {
  vus: 1,
  iterations: 8,
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% errors
    http_req_duration: ['p(95)<1000'], // p95 under 1s
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return { token: login('agent@nexus.example.com') };
}

export default function (data) {
  agentReadJourney(data.token);
  sleep(0.3);
}
