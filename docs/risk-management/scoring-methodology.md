# Risk scoring methodology

Anchor rates risks with a 5×5 likelihood × impact matrix. All authoritative scoring happens on the server; the web client only previews it.

## Scales

| Level | Likelihood | Impact |
|---|---|---|
| 1 | Rare | Negligible |
| 2 | Unlikely | Minor |
| 3 | Possible | Moderate |
| 4 | Likely | Major |
| 5 | Almost certain | Severe |

**Score = Likelihood × Impact**, an integer from 1 to 25.

The score is **ordinal**. It ranks risks against each other. It is not a probability, and it is not a financial loss. Financial exposure comes only from the separate FAIR-style quantitative model, and Anchor never presents a sum of scores as money.

When individual impact dimensions are rated (confidentiality, integrity, availability, financial and others), the overall impact is their **maximum**, never their average. This is the FIPS 199 high-water mark. Dimensions rated 0 mean "not applicable".

## Methodology versions

The bands that turn a score into a rating are versioned. Each version is immutable once shipped. Versions live in `apps/api/src/modules/risk-scoring.ts` (`METHODOLOGIES`) and are listed by `GET /api/v1/risks/methodologies`.

| Version | Bands | Status |
|---|---|---|
| `nexus-5x5@1` | 1–3 Very low · 4–7 Low · 8–14 Moderate · 15–19 High · 20–25 Very high | Frozen. It rates risks assessed before 2026-11-24. |
| `nexus-5x5@2` | 1–4 Low · 5–9 Moderate · 10–14 High · 15–19 Very High · 20–25 Critical | **Active.** It is the Anchor Risk Management default. |

Rules:

1. **A risk records the version that scored it.** This is the `risks.methodology` column. Every history snapshot records it too, in `risk_history.methodology`. A risk's own rating is always computed with its own version, so moving the default never silently re-rates an existing assessment.
2. **New risks use the active version.** In the database, the column default is the active key.
3. **Re-scoring is a new assessment.** Changing any likelihood, impact, impact dimension or review frequency moves the risk to the active version, and the history row records it. An edit that touches no scores leaves the version alone.
4. **Aggregates use the active version.** The portfolio, heat maps, rating panels, the register's rating filter and the trend all band every score with the active version, so their counts are consistent with one another. A risk's detail view states which version rated it.
5. **Review cadence depends on the score, not the label.** Re-banding must not move review dates.

| Score | Review every |
|---|---|
| 20–25 | 30 days |
| 15–19 | 60 days |
| 8–14 | 90 days |
| 4–7 | 180 days |
| 1–3 | 365 days |

Organization appetite and tolerance are compared against the **score**, so they don't depend on band labels.

## Migration from v1 to v2 (`0087_risk_methodology.sql`)

The migration is non-destructive:

- It adds `risks.methodology NOT NULL DEFAULT 'nexus-5x5@1'`, which fills every existing row with v1, then switches the default to `@2`.
- It adds `risk_history.methodology`, with existing rows set to `@1`.
- A CHECK constraint limits the column to known versions.

**Effect on existing data:** none until a risk is next re-scored. When one is, its rating may change band. For example, 16 is "High" under v1 and "Very High" under v2. 20 to 25 is "Very high" under v1 and "Critical" under v2. A score of 3 is "Very low" under v1 and "Low" under v2.

**Rollback:** set the column default back to `'nexus-5x5@1'` and redeploy the previous API. No data needs rewriting, because every row still names the version that scored it.

## Adding a version

1. Add an entry to `METHODOLOGIES` with a new key such as `nexus-5x5@3`. Never edit an existing entry.
2. Add the key to the `risks_methodology_known` CHECK constraint in a new migration.
3. If it becomes active, change `ACTIVE_METHODOLOGY` and the column default together in the same release.
4. Unit tests assert that every version's bands are ordered, complete (they cover 1–25) and keyed `family@version`.

Per-organization custom thresholds and weighted-impact scoring (specification §8) are planned as a table layered over this registry. Until then, every organization shares the versions above.
