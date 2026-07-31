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
  const outcome = (name) => rows.filter((r) => r.outcome === name).length;

  console.log(`\n${label}  (n=${total})`);

  // ── WHAT WE COULD EXTRACT ──────────────────────────────────────────────────
  // Mechanical, measured on every logged page. This is the high-volume number.
  console.log('  EXTRACTION (every logged page)');
  console.log(`    coordinate                ${pct(outcome('found'), total)}   ${outcome('found')}/${total}`);
  console.log(`    address only              ${pct(outcome('found_address'), total)}   — geocodable, no point`);
  console.log(`    ambiguous (page disagreed) ${pct(outcome('ambiguous'), total)}`);
  console.log(`    nothing                   ${pct(outcome('not_found'), total)}`);

  const tierOf = (n) => rows.filter((r) => r.result?.tier === n).length;
  console.log(
    `    answered by tier          1: ${pct(tierOf(1), total)}  2: ${pct(tierOf(2), total)}  3: ${pct(tierOf(3), total)}`,
  );

  // WHY THE TIERS GAVE UP. The most useful output of this phase: "no coordinates published" is a
  // finding about the site, "coordinates present but refused" is a finding about us, and they call
  // for opposite responses.
  for (const [tier, field] of [
    ['tier 1', 'tier1Reason'],
    ['tier 2', 'tier2Reason'],
    ['tier 3', 'tier3Reason'],
  ]) {
    const counts = new Map();
    for (const r of rows) {
      const reason = r.tiers?.[field];
      if (!reason) continue;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    console.log(`    why ${tier} gave up:`);
    for (const [reason, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${pct(n, total).padStart(6)}  ${reason}`);
    }
  }

  // ── WHETHER IT WAS RIGHT ───────────────────────────────────────────────────
  //
  // A SEPARATE denominator, stated every time. Only a person can say whether a coordinate is the
  // right place, so this is measured on a subsample — and an extraction rate over 100 pages beside
  // a correctness rate over 12 must never read as one number.
  const withCoordinate = rows.filter((r) => r.outcome === 'found');
  const verified = withCoordinate.filter((r) => r.verified === 'correct' || r.verified === 'wrong');
  const correct = verified.filter((r) => r.verified === 'correct');
  const wrong = verified.filter((r) => r.verified === 'wrong').length;

  console.log(`  CORRECTNESS (verified subsample: n=${verified.length} of ${withCoordinate.length} with a coordinate)`);
  if (verified.length === 0) {
    console.log('    NOT MEASURED — nothing was verified, so the wrong-rate is unknown.');
    console.log('    The wrong-rate is the number that decides this project. Verify some.');
  } else {
    console.log(`    correct                   ${pct(correct.length, verified.length)}   ${correct.length}/${verified.length}`);
    console.log(`    WRONG                     ${pct(wrong, verified.length)}   ${wrong}/${verified.length}   <- must be ~0`);
    if (verified.length < 10) {
      console.log(`    ⚠ ${verified.length} verified is too few to trust this rate.`);
    }
  }

  // ── LATENCY ────────────────────────────────────────────────────────────────
  const latencyOf = (r) => r.timing?.readingReadyMs;
  const navigationDelay = (r) => r.timing?.navigationDelayMs ?? 0;
  const probeDelay = (r) => r.timing?.probeDelayMs ?? 0;
  // The two bound the true value from OPPOSITE sides and must not be summed.
  const worstCase = (r) => (Number.isFinite(latencyOf(r)) ? latencyOf(r) + navigationDelay(r) : NaN);
  const bestCase = (r) =>
    Number.isFinite(latencyOf(r)) ? Math.max(0, latencyOf(r) - probeDelay(r)) : NaN;

  const timed = withCoordinate.filter((r) => Number.isFinite(worstCase(r)) && Number.isFinite(r.timing?.totalMs));
  const inBudget = timed.filter(
    (r) => worstCase(r) <= LATENCY_BUDGET_MS && r.timing.totalMs <= EXTRACT_BUDGET_MS,
  ).length;
  // Best case inside the budget and worst case outside: we cannot say which side it fell, and
  // guessing either way biases the headline number.
  const straddling = timed.filter(
    (r) => bestCase(r) <= LATENCY_BUDGET_MS && worstCase(r) > LATENCY_BUDGET_MS,
  ).length;

  const readyTimes = timed.map(worstCase).filter(Number.isFinite);
  const extractTimes = rows.map((r) => r.timing?.totalMs).filter(Number.isFinite);
  const ms = (v) => (v == null ? 'unmeasured' : `${v}ms`);

  console.log(`  LATENCY (of ${withCoordinate.length} coordinate reads, ${timed.length} timed)`);
  console.log(`    inside budget             ${pct(inBudget, timed.length)}`);
  if (straddling > 0) {
    console.log(`    straddles the budget      ${pct(straddling, timed.length)}  — error bar spans it, not counted`);
  }
  console.log(
    `    reading ready  p50 ${ms(quantile(readyTimes, 0.5))}   p95 ${ms(quantile(readyTimes, 0.95))}   (budget ${LATENCY_BUDGET_MS}ms)`,
  );
  console.log(
    `    extraction     p50 ${ms(quantile(extractTimes, 0.5))}   p95 ${ms(quantile(extractTimes, 0.95))}   (budget ${EXTRACT_BUDGET_MS}ms)`,
  );

  const errors = rows.map((r) => r.errorMetres).filter(Number.isFinite);
  if (errors.length > 0) {
    console.log(
      `    positional error  p50 ${quantile(errors, 0.5)}m   p95 ${quantile(errors, 0.95)}m   (n=${errors.length})`,
    );
  }
}

summarise(records, 'ALL SITES');

// ONE FILE, SPLIT BY SITE. Each record carries its own family and variant, so a session covering
// both sites is a single export and the comparison is made here rather than across separate runs.
const byFamily = new Map();
for (const r of records) {
  const key = String(r.family ?? 'unknown');
  if (!byFamily.has(key)) byFamily.set(key, []);
  byFamily.get(key).push(r);
}
if (byFamily.size > 1) {
  for (const [family, rows] of byFamily) summarise(rows, family.toUpperCase());
}

const byVariant = new Map();
for (const r of records) {
  const key = String(r.variant ?? 'unknown');
  if (!byVariant.has(key)) byVariant.set(key, []);
  byVariant.get(key).push(r);
}
if (byVariant.size > 1) {
  for (const [variant, rows] of byVariant) summarise(rows, `VARIANT: ${variant}`);
}



console.log(`
NOT MEASURED BY THIS REPORT
  Tier 3 counts only whether an address STRING was present. Turning one into a coordinate needs a
  geocoder, which this harness deliberately does not call — so a tier-3 "found" is an upper bound on
  what tier 3 would really deliver, short by the geocoder's own error rate.

  Supply coverage (the second gate) is not here either: it needs the proximity endpoint, which does
  not exist yet. Run it against the transmitted points once it does.
`);
