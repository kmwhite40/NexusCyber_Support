// Load test — ramping concurrent agents performing read journeys.
//   k6 run load/load.js
import { sleep } from 'k6';
import { login, agentReadJourney } from './helper.js';

export const options = {
  scenarios: {
    agents: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 }, // ramp up
        { duration: '40s', target: 30 }, // sustained
        { duration: '15s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'], // <2% errors under load
    http_req_duration: ['p(95)<1500', 'p(99)<2500'],
    checks: ['rate>0.98'],
  },
};

export function setup() {
  return { token: login('agent@nexus.example.com') };
}

export default function (data) {
  agentReadJourney(data.token);
  sleep(Math.random() * 0.8 + 0.2); // 0.2–1.0s think time
}
