#!/usr/bin/env node
// Turns an exported measurement file into the numbers the phase 1 decision is made on.
//
//   node tools/report.mjs measurements/ftnss-phase1-2026-08-04.json
//
// Reports MISS and WRONG separately, always. They are different failures: a miss is the panel
// honestly saying it could not read the page, which is acceptable behaviour. A wrong is a gym
// pinned next to the wrong hotel, which is the panel lying with confidence. Collapsing them into
// one "accuracy" figure is how a project ships on a number that looked fine.

import { readFileSync } from 'node:fs';

const LATENCY_BUDGET_MS = 800;
const EXTRACT_BUDGET_MS = 150;

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/report.mjs <exported-measurements.json>');
  process.exit(2);
}

let records;
try {
  records = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`could not read ${path}: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(records) || records.length === 0) {
  console.error('no records in that file');
  process.exit(2);
}

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function summarise(rows, label) {
  const total = rows.length;
  // A hit REQUIRES an extracted coordinate. A `correct` verdict on a record whose result was
  // `found_address` or `not_found` is not a hit — tier 3 produces a string, not a location, and
  // counting one would inflate the single number the phase-1 decision is made on. The recorder no
  // longer offers those verdicts, but old exports predate that and the report must not trust its
  // input. (Codex review, PR #1.)
  const correct = rows.filter((r) => r.verdict === 'correct' && r.result?.status === 'found');
  const inconsistent = rows.filter(
    (r) => r.verdict === 'correct' && r.result?.status !== 'found',
  ).length;
  const wrong = rows.filter((r) => r.verdict === 'wrong').length;
  const unverifiable = rows.filter((r) => r.verdict === 'unverifiable').length;
  const noRead = rows.filter((r) => r.verdict === 'no_read').length;

  // A hit is correct AND inside the latency budget. A correct read that arrives after the user has
  // moved on is worth nothing, so it does not count as one.
  const withinBudget = correct.filter(
    (r) =>
      (r.timing?.readyToPanelMs ?? Infinity) <= LATENCY_BUDGET_MS &&
      (r.timing?.totalMs ?? Infinity) <= EXTRACT_BUDGET_MS,
  ).length;

  const readyTimes = rows.map((r) => r.timing?.readyToPanelMs).filter(Number.isFinite);
  const extractTimes = rows.map((r) => r.timing?.totalMs).filter(Number.isFinite);

  console.log(`\n${label}  (n=${total})`);
  console.log(`  HIT (correct + in budget)  ${pct(withinBudget, total)}   ${withinBudget}/${total}`);
  console.log(`  correct, over budget       ${pct(correct.length - withinBudget, total)}`);
  console.log(`  WRONG                      ${pct(wrong, total)}   ${wrong}/${total}   <- must be ~0`);
  console.log(`  miss (honest failure)      ${pct(noRead, total)}`);
  console.log(`  unverifiable               ${pct(unverifiable, total)}`);
  if (inconsistent > 0) {
    console.log(
      `  ⚠ ${inconsistent} record(s) marked "correct" with no extracted coordinate — NOT counted as hits`,
    );
  }

  const tierOf = (n) => rows.filter((r) => r.result?.tier === n).length;
  console.log(
    `  answered by tier           1: ${pct(tierOf(1), total)}  2: ${pct(tierOf(2), total)}  3: ${pct(tierOf(3), total)}`,
  );
  console.log(
    `  tier availability          1: ${pct(rows.filter((r) => r.tiers?.tier1 === 'found').length, total)}` +
      `  2: ${pct(rows.filter((r) => r.tiers?.tier2 === 'found').length, total)}` +
      `  3: ${pct(rows.filter((r) => r.tiers?.tier3 === 'found_address').length, total)}`,
  );
  console.log(
    `  ready→panel  p50 ${quantile(readyTimes, 0.5)}ms   p95 ${quantile(readyTimes, 0.95)}ms   (budget ${LATENCY_BUDGET_MS}ms)`,
  );
  console.log(
    `  extraction   p50 ${quantile(extractTimes, 0.5)}ms   p95 ${quantile(extractTimes, 0.95)}ms   (budget ${EXTRACT_BUDGET_MS}ms)`,
  );

  const precisionOf = (v) => rows.filter((r) => r.precisionVerdict === v).length;
  const assessed = total - precisionOf('not_assessed');
  if (assessed > 0) {
    console.log(
      `  precision (of ${assessed} assessed)  building: ${pct(precisionOf('building'), assessed)}` +
        `  area: ${pct(precisionOf('area'), assessed)}  unclear: ${pct(precisionOf('unclear'), assessed)}`,
    );
  }

  const errors = rows.map((r) => r.errorMetres).filter(Number.isFinite);
  if (errors.length > 0) {
    console.log(
      `  positional error   p50 ${quantile(errors, 0.5)}m   p95 ${quantile(errors, 0.95)}m   (n=${errors.length})`,
    );
  }
}

summarise(records, 'ALL SITES');

const bySite = new Map();
for (const r of records) {
  // Group by registrable-ish domain so airbnb.com and airbnb.co.uk report together — the point of
  // including ccTLDs in the sample is to compare them, not to split the sample into slivers.
  const host = String(r.site || 'unknown');
  const family = host.includes('airbnb') ? 'airbnb' : host.includes('booking') ? 'booking.com' : host;
  if (!bySite.has(family)) bySite.set(family, []);
  bySite.get(family).push(r);
}
for (const [family, rows] of bySite) summarise(rows, family.toUpperCase());

console.log(`
NOT MEASURED BY THIS REPORT
  Tier 3 counts only whether an address STRING was present. Turning one into a coordinate needs a
  geocoder, which this harness deliberately does not call — so a tier-3 "found" is an upper bound on
  what tier 3 would really deliver, short by the geocoder's own error rate.

  Supply coverage (the second gate) is not here either: it needs the proximity endpoint, which does
  not exist yet. Run it against the transmitted points once it does.
`);
