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
  const ambiguousConfirmed = rows.filter((r) => r.verdict === 'ambiguous_confirmed').length;
  // Tier 3 found an address and the person confirmed it. NOT a hit — a hit needs a coordinate, and
  // turning an address into one needs a geocoder this harness does not call. But emphatically not a
  // miss either: it is the case the product could still serve, and counting it as failure is what
  // made tier 3 look useless in the data meant to decide whether it is.
  const addressCorrect = rows.filter((r) => r.verdict === 'address_correct').length;
  const addressWrong = rows.filter((r) => r.verdict === 'address_wrong').length;

  // A hit is correct AND inside the latency budget. A correct read that arrives after the user has
  // moved on is worth nothing, so it does not count as one.
  //
  // A MISSING latency is not an over-budget one. Coercing null to Infinity classified every record
  // without a timing as too slow — and on SPA sites that was most of the sample, so a measurement
  // artifact would have driven the headline number down and read as a product failure. A record
  // with no latency is counted on correctness and reported separately as unmeasured, never
  // silently failed. (Codex review round 3, PR #1.)
  const latencyOf = (r) => r.timing?.readingReadyMs;
  // WORST CASE, not the flattering one: a polled detection can be up to one interval late, so the
  // measured latency understates the real one by `latencyUncertaintyMs`. Adding it before the
  // comparison means a panel that may really have taken longer than the budget is not counted as a
  // hit on the strength of how it was measured. (Codex review round 4, PR #1.)
  // The two uncertainties bound the true latency from OPPOSITE sides, and were previously summed
  // into a single "worst case". That inflated every probe-delayed reading: a 750ms read with 250ms
  // of probe delay is bounded ABOVE by 750ms, and was being reported as possibly 1000ms and dropped
  // from the hits — the report penalising a reading for how carefully it was measured.
  // (Codex review round 25, PR #1.)
  const navigationDelay = (r) => r.timing?.navigationDelayMs ?? r.latencyUncertaintyMs ?? 0;
  const probeDelay = (r) => r.timing?.probeDelayMs ?? 0;
  const worstCaseLatency = (r) =>
    Number.isFinite(latencyOf(r)) ? latencyOf(r) + navigationDelay(r) : NaN;
  // A hit needs latency that was MEASURED and inside the budget. Round 3 fixed missing-latency being
  // treated as too slow; the fix over-corrected into treating it as fast enough, which inflates the
  // headline number instead of deflating it. Neither is right: an unmeasured record is not evidence
  // of meeting a budget, so it is excluded from hits and reported on its own line.
  // (Codex review round 5, PR #1.)
  // A reading whose BEST case is inside the budget and whose WORST case is outside straddles it. We
  // cannot say which side it fell, and guessing in either direction biases the headline number, so
  // it is reported on its own line rather than counted. (Codex review round 23, PR #1.)
  const bestCaseLatency = (r) =>
    Number.isFinite(latencyOf(r)) ? Math.max(0, latencyOf(r) - probeDelay(r)) : NaN;
  const straddles = (r) =>
    Number.isFinite(latencyOf(r)) &&
    bestCaseLatency(r) <= LATENCY_BUDGET_MS &&
    worstCaseLatency(r) > LATENCY_BUDGET_MS;

  const measured = (r) => Number.isFinite(worstCaseLatency(r)) && Number.isFinite(r.timing?.totalMs);
  const inBudget = (r) =>
    worstCaseLatency(r) <= LATENCY_BUDGET_MS && r.timing.totalMs <= EXTRACT_BUDGET_MS;
  const withinBudget = correct.filter((r) => measured(r) && inBudget(r) && !straddles(r)).length;
  const straddling = correct.filter((r) => measured(r) && straddles(r)).length;
  const unmeasuredLatency = correct.filter((r) => !measured(r)).length;
  // Straddling readings are reported on their own line, so they must not also appear here — a row
  // counted in two buckets makes the percentages sum past 100 and reads as worse than it is.
  const correctButSlow = correct.filter((r) => measured(r) && !inBudget(r) && !straddles(r)).length;

  const readyTimes = rows.map(worstCaseLatency).filter(Number.isFinite);
  const extractTimes = rows.map((r) => r.timing?.totalMs).filter(Number.isFinite);

  console.log(`\n${label}  (n=${total})`);
  console.log(`  HIT (correct + in budget)  ${pct(withinBudget, total)}   ${withinBudget}/${total}`);
  console.log(`  correct, over budget       ${pct(correctButSlow, total)}`);
  if (straddling > 0) {
    console.log(
      `  correct, latency STRADDLES the budget  ${pct(straddling, total)}  — detection error spans it, not counted`,
    );
  }
  if (unmeasuredLatency > 0) {
    console.log(
      `  correct, latency UNMEASURED ${pct(unmeasuredLatency, total)}  — not counted as hits either way`,
    );
  }
  console.log(`  WRONG                      ${pct(wrong, total)}   ${wrong}/${total}   <- must be ~0`);
  console.log(`  miss (honest failure)      ${pct(noRead, total)}`);
  console.log(`  ambiguous (page disagreed) ${pct(ambiguousConfirmed, total)}`);
  console.log(
    `  ADDRESS ONLY, correct      ${pct(addressCorrect, total)}   — geocodable, not a hit here`,
  );
  if (addressWrong > 0) {
    console.log(`  address only, WRONG        ${pct(addressWrong, total)}`);
  }
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
  const ms = (v) => (v == null ? 'unmeasured' : `${v}ms`);
  console.log(
    `  reading ready  p50 ${ms(quantile(readyTimes, 0.5))}   p95 ${ms(quantile(readyTimes, 0.95))}   (budget ${LATENCY_BUDGET_MS}ms)`,
  );
  console.log(
    `  extraction   p50 ${ms(quantile(extractTimes, 0.5))}   p95 ${ms(quantile(extractTimes, 0.95))}   (budget ${EXTRACT_BUDGET_MS}ms)`,
  );

  const precisionOf = (v) => rows.filter((r) => r.precisionVerdict === v).length;
  const assessed = precisionOf('building') + precisionOf('area') + precisionOf('unclear');
  if (assessed > 0) {
    console.log(
      `  precision (of ${assessed} assessed)  building: ${pct(precisionOf('building'), assessed)}` +
        `  area: ${pct(precisionOf('area'), assessed)}  unclear: ${pct(precisionOf('unclear'), assessed)}`,
    );
  }

  // WHY THE TIERS FAILED. The single most useful output of this phase, and it did not exist until a
  // real session produced three `not_found`s and no way to tell whether the site was unreadable or
  // the harness was broken. "lodging type found, no usable geo" and "no ld+json blocks on page" are
  // completely different findings and call for opposite responses.
  for (const [tier, field] of [['tier 1', 'tier1Reason'], ['tier 2', 'tier2Reason'], ['tier 3', 'tier3Reason']]) {
    const counts = new Map();
    for (const r of rows) {
      const reason = r.tiers?.[field];
      if (!reason) continue;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    console.log(`  why ${tier} gave up:`);
    for (const [reason, n] of ranked) console.log(`      ${pct(n, total).padStart(6)}  ${reason}`);
  }

  const unsettled = rows.filter((r) => r.domSettled === false).length;
  if (unsettled > 0) {
    console.log(`  ⚠ ${unsettled} record(s) taken before the page settled — treat with suspicion`);
  }

  const errors = rows.map((r) => r.errorMetres).filter(Number.isFinite);
  if (errors.length > 0) {
    console.log(
      `  positional error   p50 ${quantile(errors, 0.5)}m   p95 ${quantile(errors, 0.95)}m   (n=${errors.length})`,
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
