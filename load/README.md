# Load & performance tests (k6)

Implements the load / soak portions of the test strategy
([docs/nexus/11-roadmap-build-test.md §AA](../docs/nexus/11-roadmap-build-test.md)).
All scripts authenticate as a seeded demo agent and exercise the read-heavy journeys
the service desk performs continuously (queue, analytics, posture, on-call, catalog).

| Script | Purpose | Thresholds |
|--------|---------|-----------|
| `smoke.js` | Post-deploy correctness at minimal load | p95 < 1s, errors < 1% |
| `load.js` | Ramping concurrency (0 → 30 VUs) | p95 < 1.5s, p99 < 2.5s, errors < 2% |
| `soak.js` | Constant load over a long window (leak/drift detection) | p95 < 1.5s, errors < 1% |

The API and a seeded database must be running (`npm run dev` or
`docker compose -f docker-compose.prod.yml up`).

## Run with Docker (no host install)

```bash
# smoke (host API on :4000)
docker run --rm -i -e BASE_URL=http://host.docker.internal:4000/api/v1 \
  -v "$PWD/load:/load" grafana/k6 run /load/smoke.js

# load
docker run --rm -i -e BASE_URL=http://host.docker.internal:4000/api/v1 \
  -v "$PWD/load:/load" grafana/k6 run /load/load.js

# soak (e.g. 30 minutes, 15 VUs)
docker run --rm -i -e BASE_URL=http://host.docker.internal:4000/api/v1 \
  -e DURATION=30m -e VUS=15 -v "$PWD/load:/load" grafana/k6 run /load/soak.js
```

## Run with a local k6

```bash
brew install k6   # or see https://k6.io/docs/get-started/installation/
BASE_URL=http://localhost:4000/api/v1 k6 run load/smoke.js
```

## Notes

- These use the **dev-login** path (non-production). Against a production deployment,
  swap `helper.login()` for a real OIDC client-credentials token.
- The journeys are **read-only and idempotent**, so they're safe to run repeatedly
  against a seeded environment without mutating data.
- A failing threshold makes `k6` exit non-zero — wire `smoke.js` into the deploy
  pipeline as a post-deploy gate.
