// Soak test — constant moderate load over a long window to surface leaks/drift.
//   DURATION=30m k6 run load/soak.js
import { sleep } from 'k6';
import { login, agentReadJourney } from './helper.js';

const DURATION = __ENV.DURATION || '10m';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 10),
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Latency should stay flat over the soak — no upward drift from leaks.
    http_req_duration: ['p(95)<1500'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return { token: login('agent@nexus.example.com') };
}

export default function (data) {
  agentReadJourney(data.token);
  sleep(1);
}
