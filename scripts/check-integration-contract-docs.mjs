#!/usr/bin/env node
// Guards the external integration contract's documentation against the code that implements it.
//
// Two classes of drift, both of which actually happened while building ADR-0016's endpoint:
//   1. The contract doc listing a different field set than `payloadSchema` accepts.
//   2. A doc claiming behaviour that did not ship. The Carbon response doc goes to an external
//      party; a consumer reading it built `parentExternalRef` into a Sprint 1 payload would get
//      a 422 on every call. ADR-0016 is what the next engineer reads to learn what this does.
//
// Usage: node scripts/check-integration-contract-docs.mjs [baseDir]
// baseDir defaults to the repo root; pass a directory of extracted older files to test the gate.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(base, rel), 'utf8');

const MODULE = 'apps/api/src/modules/integration-tickets.ts';
const CONTRACT = 'docs/nexus/anchor-integration-external-contract.md';
const ADR = 'docs/knowledge/architecture-decisions/ADR-0016-strict-integration-ticket-endpoint.md';
const RESPONSE = 'docs/nexus/carbon-conmon-integration-response.md';

const mod = read(MODULE);
const between = (text, start, end) => text.split(start)[1].split(end)[0];
const quoted = (text) => new Set([...text.matchAll(/'(\w+)'/g)].map((m) => m[1]));

const schemaKeys = new Set(
  [...between(mod, 'const payloadSchema', '.strict()').matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]),
);
const notApplied = quoted(between(mod, 'const NOT_APPLIED =', ']'));
const deferred = quoted(between(mod, 'const DEFERRED = [', ']'));

// Does any production file actually SET suppressSla, as opposed to declaring or reading it?
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name.includes(' 2') ? [] : walk(full); // skip iCloud copies
    return name.endsWith('.ts') ? [full] : [];
  });
const suppressIsSet = walk(join(base, 'apps/api/src')).some((f) =>
  /suppressSla\s*[:=]\s*(true|Boolean|\w+\.\w+)/.test(readFileSync(f, 'utf8')),
);

const problems = [];

// ---- 1. the contract doc's field tiers must match the schema ----
const sec = between(read(CONTRACT), '## Outbound — strict upsert (preferred)', '## Inbound');
const appliedDoc = new Set(
  [...sec.matchAll(/^\| (\w+) \|/gm)].map((m) => m[1]).filter((f) => f !== 'field'), // table header
);
const naDoc = quoted(`'${[...between(sec, '### Accepted but not applied', '###').matchAll(/`(\w+)`/g)].map((m) => m[1]).join("','")}'`);
const defDoc = new Set([...between(sec, '### Refused — 422', '###').matchAll(/`(\w+)`/g)].map((m) => m[1]));

const missingFromDoc = [...schemaKeys].filter((k) => !appliedDoc.has(k) && !notApplied.has(k));
const invented = [...appliedDoc].filter((k) => !schemaKeys.has(k));
const naMissing = [...notApplied].filter((k) => !naDoc.has(k));
const defMissing = [...deferred].filter((k) => !defDoc.has(k));
if (missingFromDoc.length) problems.push(`schema fields absent from the contract doc: ${missingFromDoc.join(', ')}`);
if (invented.length) problems.push(`contract doc documents fields the schema lacks: ${invented.join(', ')}`);
if (naMissing.length) problems.push(`NOT_APPLIED fields absent from the doc: ${naMissing.join(', ')}`);
if (defMissing.length) problems.push(`DEFERRED fields absent from the doc: ${defMissing.join(', ')}`);

// ---- 2. no doc may claim unshipped behaviour ----
const adr = read(ADR);
const aPrimeRow = read(RESPONSE).split('\n').find((l) => l.startsWith('| **A′**')) ?? '';
for (const [label, text] of [['ADR-0016', adr], ['the A′ row', aPrimeRow]]) {
  if (deferred.has('parentExternalRef') && /resolves `?parentExternalRef`? to|`parentExternalRef` resolution/.test(text)) {
    problems.push(`${label} claims parentExternalRef resolution, but it is refused as phase D`);
  }
  if (!suppressIsSet && /\*\*Suppresses SLA clock start|mandatory SLA-clock suppression/.test(text)) {
    problems.push(`${label} claims SLA suppression is active, but no production code sets suppressSla`);
  }
}

if (problems.length) {
  console.error('FAIL\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(
  `PASS ${appliedDoc.size} applied + ${notApplied.size} reported = ${schemaKeys.size} schema keys; ` +
    `${deferred.size} deferred documented; suppressSla set by production code: ${suppressIsSet}`,
);
