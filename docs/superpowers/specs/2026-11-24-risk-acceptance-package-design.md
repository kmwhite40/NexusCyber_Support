# Risk acceptance package (PDF for Authorizing Official signature) — design

Date: 2026-11-24 · Status: draft for approval

## Intent

An Authorizing Official (AO) signs risk acceptances on paper (wet ink or a PIV digital signature
applied outside Anchor). Anchor must produce the document the AO signs, then let someone record
the signed decision back against the risks with the signed copy as evidence. First use: the GDAP
acceptances (SBS Federal GDAP-SBS-01/02, Quantifind GDAP-QFND-01/02; RA-2026-03 for Quantifind).

Today the only export is a register CSV. The acceptance workflow exists (request → decide, with
separation of duties) but has no document an AO can sign and no way to attach a signature.

## Goals

- Generate an **acceptance package** for **one organization**: the risks awaiting acceptance, with
  everything the AO needs to decide, and a signature block. Opens print-ready; saved as PDF by the
  browser.
- Every package has an ID, is recorded and audited, and its content is frozen at issue so the
  signed paper can always be matched to exactly what Anchor produced.
- Record the signed result: upload the signed copy, enter who signed and when, and the decision
  per risk. Approved risks become *accepted* through the existing decision path.

## Non-goals

- Electronic signature inside Anchor; emailing or routing the package to the AO.
- A general "register as PDF" report, portfolio or cross-organization reports.
- A server-side PDF library (repo standard: no new frameworks/libraries without need).

## Anti-goals (failure even if it works)

- **Any other organization's data in a package.** The user's rule: no customer's risk register
  inputs on the same report as another's. Not names, not counts, not portfolio figures.
- A package whose content changes after it is issued.
- A risk marked accepted from a package without the signed copy attached.

## Constraints

- RLS on every new table, standard isolation policy; every cross-reference checked same-org.
- Forward-only migration (`0092_…`); permissions dual-written to migration and `seed.ts` if any are added.
- Azure Government only; no external services.
- Existing acceptance rules hold: decision needs `risk.accept`; the requester of a risk cannot
  decide it; acceptance expiry is capped by the org's `max_acceptance_days`.

## Approaches

1. **Browser-built print page** (the Billing statement pattern). No dependency, but the server never
   knows a package exists: no ID, no audit, no frozen content. Rejected: too weak for a signed record.
2. **Server PDF via a library.** Byte-identical output, but adds a library and fiddly layout code
   against the repo's dependency standard.
3. **Server-generated print HTML, saved as PDF by the browser.** — **Chosen by the user.** The API
   builds the package for one org, freezes and hashes it, audits it, and returns print-ready HTML;
   the web opens it and triggers print. Traceable and audited with no new dependency. Page breaks
   vary slightly by browser; print CSS contains that.

## Design

### Which risks go in

Risks of the one organization with `acceptance_status = 'requested'` (the request carries the
justification and expiry the AO is accepting). The generator defaults to all of them and lets the
user untick some. *My call:* a risk can be in at most one **issued** (unsigned, not void) package
at a time, so two different papers cannot be signed for the same request.

### Package record — `risk_acceptance_packages` (new, RLS)

`id`, `organization_id`, `package_number` (per org, shown as `AP-0001`, numbered under an advisory
lock like `risk_number`), `risk_ids uuid[]`, `snapshot jsonb` (the exact data rendered),
`html text` (the exact page served), `sha256` (of the snapshot — a page cannot print the hash of
itself, so the hash identifies the frozen data the AO saw; the stored html is what makes reprints identical), `status` (`issued` | `signed` | `void`),
`generated_by`, `generated_at`, and when signed: `signed_by_name`, `signed_by_title`, `signed_on`
(date on the paper), `recorded_by`, `recorded_at`, `signed_attachment_id`.

Also `reference text` (optional, e.g. `RA-2026-03`): the acceptance document number the
organization uses, printed in the header beside `AP-0001`. *My call*, from the GDAP register,
which cites RA-2026-03 as the Quantifind acceptance.

Re-opening a package re-serves the stored `html`, never re-renders, so a reprint is identical.
Voiding (by `risk.manage`, with a reason; only `issued` packages) frees its risks for a new package.

### Direct approval while a risk is in a package — *decided by the user*

The existing Approve/Reject on a risk's Acceptance tab (`decideAcceptance`) stays. But while a risk
is in an **issued** package, a direct decision is refused (409, "awaiting a signed acceptance
package AP-0001") and the UI shows that instead of the buttons. Once the package is signed or
voided, the risk is free again. This keeps the AO's paper from being overtaken by a click, and
leaves the quick path for organizations without a formal AO.

### Content (one organization only)

- **Cover/header on every page:** organization name, "Risk Acceptance Package AP-0001", generated
  date and generator, package ID + first 12 chars of the hash in the footer, page numbering.
- **Summary table:** each risk's ref, title, residual score/rating vs. the org's appetite and
  tolerance, requested expiry.
- **Per risk (each starts on a new page):** ref and title; risk statement (because of / this may
  happen / leading to); category, owner, threat source, velocity; inherent, residual and target
  likelihood × impact with ratings; impact dimensions; full description (evidence, existing
  controls); linked controls (id + title, CMMC and NIST); treatment plan (title, status, due);
  acceptance justification, requested expiry, requested by and when.
  Decision line for the AO: ☐ Accept until `<expiry>` ☐ Do not accept, initials.
- **Signature block (last page):** statement that the AO accepts the risks marked Accept for the
  periods shown; AO name, title, signature, date; and the package ID repeated.

Only data of that organization is queried; the renderer takes a single-org snapshot and nothing else.

### Recording the signed package

"Record signature" on an issued package (needs `risk.accept`):
upload the signed copy (PDF or image, via existing storage validation and scanning), enter AO name,
title and signed date, and a decision per risk: **Accepted**, **Not accepted**, or **Not marked**
(the AO left it blank). No default; submit is refused until every risk has one. *My call.*
A Not marked risk stays `requested` and is free for a new package; the package still becomes
`signed`, and its record lists which risks were not marked. In one transaction:

- Refuse if the signed copy is missing, the scan is not clean (the scanner is synchronous, so this
  is checked in the transaction), or the package is not `issued`.
- Refuse if any Accepted risk's requested expiry has already passed, or the signed date is after
  it — the package must be reissued with a new request. *My call.*
- Per risk: refuse the whole record if the risk's acceptance request changed since issue
  (justification, expiry, residual score differ from the snapshot) — *my call*: a new package is
  needed, because the AO signed something else.
- Apply the existing decision logic per risk (separation of duties: recorder ≠ requester), with a
  history note "Signed by <name>, <title> on <date>; package AP-0001 (<sha12>)".
- Mark the package `signed`; audit `risk.acceptance_package.record`.

`acceptance_decided_by` remains the recorder (the Anchor user); the AO's identity lives on the
package and in the history note.

### Attachments

Attachments are ticket-only today (`attachments.ticket_id NOT NULL`). Extend the table:
`ticket_id` nullable, add `acceptance_package_id` (FK), `CHECK (num_nonnulls(ticket_id, acceptance_package_id) = 1)`.
Reuse `blobStore`, `scanner`, `validateUpload`, the download path and its audit. Download of a
package's signed copy needs `risk.read` in that org.

### API (in `routes-risks.ts`)

- `GET  /risks/acceptance-packages?organizationId=` — list.
- `POST /risks/acceptance-packages` `{ organizationId, riskIds? }` — create; every id must be a
  requested risk of that org, else 400. Needs `risk.manage`. Audits `risk.acceptance_package.issue`.
- `GET  /risks/acceptance-packages/:id/html` — the stored page. Audits `…export` (a disclosure).
- `POST /risks/acceptance-packages/:id/record` (multipart) — record as above.
- `POST /risks/acceptance-packages/:id/void` `{ reason }`.

### Web

- Risks page: an **Acceptance packages** button beside Export CSV, opening a panel that lists the
  org's packages (number, status, risks, generated, signed by) and offers **Generate package**.
- Generate dialog: requested risks with checkboxes → create → open the print page.
  The page is fetched with the user's token and written into a new window (as Billing does), since
  a plain link cannot carry the bearer token; it triggers print on load.
- Package row actions: Reprint, Record signature (dialog as above), Void, download signed copy.
- Risk detail → Acceptance tab: shows the package(s) a risk is in and, once signed, the AO, date and
  a link to the signed copy.

### First use (GDAP) — operational, not built

The GDAP import left the Accept risks in `treating` with no acceptance request. Before a package can
be generated, someone files the acceptance requests in the UI (justification, expiry within the
org's maximum). Separation of duties means the requester cannot record the signature, so first use
needs **two people with `risk.accept`** in each organization: one requests, the other records. No
script copies requests from the register.

## Left to the builder

Exact print CSS and page-number technique; package list layout; how the snapshot JSON is shaped;
test fixtures. Tests must cover: cross-org risk id refused; a second org's data absent from the
HTML; reprint byte-identical (same sha256); changed risk blocks recording; requester cannot record
their own risk; missing or unclean signed copy refused; voiding frees risks; direct decide refused
while in an issued package and allowed after; Not marked leaves the risk requested and free;
expired or late-signed acceptance refused. Download of a package's signed copy authorizes
`risk.read` (ticket attachments keep `ticket.comment`).
