// Local measurement storage — the recorded verdicts, and the operator's declared cohort.
//
// NO PAGE IDENTIFIER IS STORED. Not the URL, not the hostname, not the address text.
//
// An earlier version kept the URL so a disputed reading could be re-checked against the listing it
// came from, and argued the case as a bounded exception written into the rules file. That was wrong
// twice over: it put a browsing trail on disk, and changing the rules to permit it would have
// disarmed the reviewer for every later change. The rule is absolute; the instrument changed.
//
// There is also no "current reading" here any more. Readings used to be published into session
// storage for the popup to collect, which is what made a reading able to describe a page you had
// already left. The popup now asks the content script to read the page at the moment it opens, so a
// reading exists only for as long as it takes to display it.
//
// What survives:
//   • nothing derived from the URL is persisted, not even a hash;
//   • no record carries anything about the site at all — the cohort lives outside the records, in
//     the export filename, because a coarse label plus a date still proves which domain was visited;
//   • the projection is applied when a record is WRITTEN, not when it is exported, so the trail
//     never exists on disk in the first place;
//   • that projection is a strict ALLOWLIST. A denylist fails open — it protects only the fields
//     someone remembered, and every new field is exposed by default.

import { toTransmittablePoint } from './geo.js';

const KEY = 'phase1_records';
const MAX_RECORDS = 500;

/**
 * The only sites this harness runs on. The stored label comes from here, so it is a value we chose
 * rather than one the page supplied.
 */
export const SITE_LABELS = [
  'booking.com',
  'booking.co.uk',
  'booking.fr',
  'booking.de',
  ...[
    'com','co.uk','fr','de','es','it','nl','pt','ca','com.au','ie','at','ch','be','dk','se','no',
    'fi','pl','gr','cz','com.br','mx','jp',
  ].map((tld) => `airbnb.${tld}`),
];

/** Which family a label belongs to, for the headline per-site breakdown. */
export function siteFamilyFor(label) {
  if (label.startsWith('airbnb.')) return 'airbnb';
  if (label.startsWith('booking.')) return 'booking';
  return 'other';
}

/**
 * Longest match wins, so `airbnb.com.au` is not mistaken for `airbnb.com`. Anything not on the list
 * becomes 'other' — a host we never listed can never introduce a new label.
 */
export function siteLabelFor(hostname) {
  const matches = SITE_LABELS.filter(
    (label) => hostname === label || hostname.endsWith(`.${label}`),
  );
  if (matches.length === 0) return 'other';
  return matches.sort((a, b) => b.length - a.length)[0];
}

/**
 * THE COHORT THE OPERATOR DECLARED, and the only site value that is ever persisted.
 *
 * The per-site comparison is the point of this phase — Booking against Airbnb is why those two were
 * chosen — so it has to survive. But deriving that label from `location.hostname` and writing it
 * into an exported file makes the file a record of which domains were visited, which is the thing
 * this project's rules say never leaves the browser. Both were true at once, and the review kept
 * saying so, correctly.
 *
 * The operator declares which site they are measuring before they start. That preserves the whole
 * analysis and is not page-derived at all. Accuracy is protected without weakening it: the content
 * script still reports what it detected, the popup WARNS if the two disagree, and that detected
 * value stays in session storage and is never written to a record. (Codex review round 10, PR #1.)
 */
const COHORT_KEY = 'phase1_cohort';

export async function currentCohort() {
  const bag = await chrome.storage.session.get(COHORT_KEY);
  return typeof bag?.[COHORT_KEY] === 'string' ? bag[COHORT_KEY] : null;
}

export async function setCurrentCohort(cohort) {
  if (!SITE_LABELS.includes(cohort)) throw new Error('unknown cohort');
  await chrome.storage.session.set({ [COHORT_KEY]: cohort });
}

/**
 * Delete the key an older build wrote to LOCAL storage.
 *
 * Moving where a value is written does nothing for anyone who already ran the previous version: the
 * old copy simply stops being read, which looks identical to being gone and is not. This is also the
 * function the popup imported for two commits while it did not exist — see the note in popup.js.
 */
/**
 * Which cohort the CURRENT unexported batch belongs to.
 *
 * Session-scoped and stored once per batch, not once per record: it exists so a batch cannot be
 * silently mixed, and it goes no further than the export filename. It is never written into a
 * record.
 */
const BATCH_KEY = 'phase1_batch_cohort';

export async function batchCohortLabel() {
  const bag = await chrome.storage.session.get(BATCH_KEY);
  return typeof bag?.[BATCH_KEY] === 'string' ? bag[BATCH_KEY] : null;
}

export async function setBatchCohortLabel(label) {
  await chrome.storage.session.set({ [BATCH_KEY]: label });
}

export async function clearBatchCohortLabel() {
  await chrome.storage.session.remove(BATCH_KEY);
}

export async function migrateAwayLocalCohort() {
  await chrome.storage.local.remove(COHORT_KEY);
}

/**
 * Ask the content script in the active tab to read the page NOW.
 *
 * This replaced a stored "current reading". The stored version is what allowed a reading to describe
 * a page the person had already navigated away from, and no amount of navigation tracking closed
 * that reliably — reading on demand makes the question moot, because the reading is taken
 * milliseconds before it is shown.
 *
 * No permission is needed: the content script is already injected by the manifest on these hosts,
 * and messaging our own content script is not a new capability. Returns null when there is no
 * content script to answer — which is the correct answer for a page we do not measure.
 */
export async function readActivePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return null;
    return await chrome.tabs.sendMessage(tab.id, { type: 'FTNSS_READ' });
  } catch {
    return null;
  }
}

export async function loadRecords() {
  const bag = await chrome.storage.local.get(KEY);
  const records = bag?.[KEY];
  return Array.isArray(records) ? records : [];
}

/**
 * THE PROJECTION IS APPLIED ON THE WAY IN, not on the way out.
 *
 * Sanitising only at export was half a fix: storage still held the address text, the free-text note
 * and exact coordinates, so the trail existed on disk regardless of what any export did — and the
 * popup told the person those things were not stored, which made it a false statement to the user
 * as well as a privacy defect. What is never written cannot leak, cannot be exported by a future
 * code path, and cannot make the UI a liar. (Codex review round 4, PR #1.)
 */
export async function saveRecord(record) {
  const records = await loadRecords();
  // EXISTING rows go through the projection too, not just the new one.
  //
  // They were rewritten to disk unchanged on every save, so anything an earlier build had stored —
  // URLs, address text, exact coordinates — survived indefinitely while the popup stated that none
  // of it was kept. Applying the allowlist to the whole set turns each save into a migration, so the
  // claim becomes true for existing installs rather than only for fresh ones.
  // (Codex review round 15, PR #1.)
  // NO SILENT TRUNCATION. `.slice(-MAX_RECORDS)` dropped the OLDEST record once the store was full
  // while the UI still reported success — so a long collection would have lost its earliest
  // measurements, in collection order, without anyone being told. Losing data silently from a data
  // collection tool is the one failure it cannot have. Refuse instead, visibly.
  // (Codex review round 19, PR #1.)
  // One batch, one cohort. With no site field on the records, a batch containing two cohorts cannot
  // be told apart afterwards — so switching cohort with unexported records has to be refused rather
  // than silently producing a file nobody can interpret.
  const batchCohort = await batchCohortLabel();
  const declared = await currentCohort();
  if (batchCohort != null && declared != null && batchCohort !== declared) {
    throw new Error(
      `these ${records.length} records are for ${batchCohort} — export and clear before measuring ${declared}`,
    );
  }
  if (records.length === 0 && declared != null) await setBatchCohortLabel(declared);

  if (records.length >= MAX_RECORDS) {
    throw new Error(`storage is full (${MAX_RECORDS} records) — export and clear before continuing`);
  }
  const trimmed = exportableRecords([...records, record]);
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed.length;
}

// exportableRecords is defined below and used by saveRecord above — the SAME projection on both
// sides, so what is stored and what is exported can never drift apart.

/**
 * Rewrite every stored record through the projection, unconditionally.
 *
 * Migration used to be a side effect of saving, which meant it never happened in the two states an
 * abandoned old batch is most likely to be in: an orphaned batch (saving refused) and a full store
 * (saving refused). A browsing trail could therefore sit on disk indefinitely while the UI said none
 * was stored, and nothing would ever clean it. Runs at startup, before anything renders.
 * (Codex review round 25, PR #1.)
 */
export async function migrateStoredRecords() {
  const records = await loadRecords();
  if (records.length === 0) return;
  const projected = exportableRecords(records);
  await chrome.storage.local.set({ [KEY]: projected });
}

export async function clearRecords() {
  await chrome.storage.local.remove(KEY);
}

/**
 * The exact set of fields an exported record may contain — an ALLOWLIST, so a field added later is
 * withheld until someone decides it belongs, rather than shipped because nobody remembered it.
 * Every entry here is either a number we computed or a value chosen from our own vocabulary.
 */
const EXPORT_FIELDS = [
  // NO SITE FIELD AT ALL — not the hostname, not the family, not the variant.
  //
  // `{family: 'airbnb', variant: 'primary'}` looked anonymous and is not: recording is refused
  // unless the declared cohort matches the page, so that pair plus the date proves a visit to
  // airbnb.com on that day. Coarsening the value did not help, because the constraint that keeps the
  // data honest is exactly what makes it identifying.
  //
  // The cohort now lives OUTSIDE the records. One export per cohort, with the cohort in the
  // filename, and the report takes it from there. The comparison this phase exists to make survives
  // intact; what disappears is any row that says where somebody was.
  // (Codex review round 21, PR #1.)
  'recordedAt',
  'transmitted', // the ~1km point the product WOULD send — needed for the coverage gate, and
                 // already within the privacy envelope the product itself operates in
  'latencyUncertaintyMs',
  'verdict',
  'precisionVerdict',
  'softNavigation',
  'domSettled',
  'timing',
  'tiers',
  'errorMetres', // a distance we computed; carries no position
];

/**
 * The exact `source` strings the extractors may emit. An EXACT-VALUE allowlist, not a length check.
 *
 * The length check was not an allowlist at all: it accepted any string under 41 characters, so a
 * legacy record carrying an old interpolated `@type` — which was attacker-controlled page text —
 * would have been exported verbatim. "Short enough" is not a property that makes text safe.
 * (Codex review round 24, PR #1.)
 */
const KNOWN_SOURCES = new Set([
  'ld+json.geo',
  'map url ?ll',
  'map url ?center',
  'map url ?sll',
  'map url ?cbll',
  'map url ?q',
  'map url ?query',
  'map url ?markers',
  'map url ?location',
  'map url @lat,lon',
  'other',
]);

const STATUSES = new Set(['found', 'found_address', 'not_found', 'ambiguous']);
const PRECISIONS = new Set(['approximate', 'unknown']);
const TIER_STATUSES = new Set(['found', 'found_address', 'not_found', 'ambiguous']);

/** A finite, non-negative duration, or null. Anything else is a bug or page-derived; drop it. */
const asDuration = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 600_000 ? value : null;

/** The result, reduced to what the report reads: never a coordinate, never page text. */
function exportableResult(result) {
  if (result == null) return null;
  const source =
    typeof result.source === 'string' && KNOWN_SOURCES.has(result.source) ? result.source : 'other';
  return {
    status: STATUSES.has(result.status) ? result.status : 'not_found',
    tier: [1, 2, 3].includes(result.tier) ? result.tier : null,
    precision: PRECISIONS.has(result.precision) ? result.precision : null,
    source: source.startsWith('map url ') ? 'map url' : source,
  };
}

/** Rebuilt field by field, never copied. A wholesale copy exports whatever a caller put there. */
function exportableTiming(timing) {
  if (timing == null || typeof timing !== 'object') return null;
  return {
    totalMs: asDuration(timing.totalMs),
    readingReadyMs: asDuration(timing.readingReadyMs),
    addressReadyMs: asDuration(timing.addressReadyMs),
    // These two were named `readinessUncertaintyMs` until they were split apart because they bound
    // the true latency from opposite sides. The allowlist kept the OLD name, so both new fields were
    // silently dropped on export and the report's straddle logic always saw zero.
    //
    // An allowlist fails CLOSED, which is the property we want — but it fails closed silently, so a
    // producer that renames a field loses it with no error anywhere. Found by the first real record
    // exported from a browser, not by any test, because every test built its own fixtures.
    navigationDelayMs: asDuration(timing.navigationDelayMs) ?? 0,
    probeDelayMs: asDuration(timing.probeDelayMs) ?? 0,
  };
}

/**
 * The exact failure reasons the extractors may emit.
 *
 * These are OUR strings from a closed vocabulary, not page text — which is what makes them safe to
 * export. Without them a miss is `not_found, not_found, not_found`, which is a record that something
 * went wrong and no record of what: you cannot tell a site that publishes no structured data from
 * one that publishes it without coordinates, and those call for completely different responses.
 * Diagnosing the misses is most of what phase 1 is for.
 */
const KNOWN_REASONS = new Set([
  'no ld+json blocks on page',
  'ld+json present but none parsed',
  'lodging type found, no usable geo',
  'no lodging type in structured data',
  'structured data described two different places',
  'no elements to examine',
  'no map url carried a usable coordinate',
  'map urls disagreed about the location',
  'no address-shaped text found',
  'too many candidate elements to examine',
  'all three tiers failed',
  'structured data and map link disagreed about the location',
  'page did not settle after navigation',
]);

const knownReason = (value) =>
  typeof value === 'string' && KNOWN_REASONS.has(value) ? value : null;

function exportableTiers(tiers) {
  if (tiers == null || typeof tiers !== 'object') return null;
  const tier = (value) => (TIER_STATUSES.has(value) ? value : 'not_found');
  return {
    tier1: tier(tiers.tier1),
    tier2: tier(tiers.tier2),
    tier3: tier(tiers.tier3),
    // Why each tier gave up. From the closed vocabulary above, never page text.
    tier1Reason: knownReason(tiers.tier1Reason),
    tier2Reason: knownReason(tiers.tier2Reason),
    tier3Reason: knownReason(tiers.tier3Reason),
  };
}

/**
 * Re-round at the boundary rather than trusting what the caller handed us.
 *
 * `transmitted` was copied through verbatim, so the rounding guarantee lived in the ONE caller that
 * happened to apply it — which is precisely the "rounding performed by each caller" shape this
 * repo's own rules call a defect even while every current caller is correct. Rounding here means no
 * caller can bypass it, present or future. (Codex review round 5, PR #1.)
 */
function boundaryPoint(value) {
  if (value == null || typeof value !== 'object') return null;
  return toTransmittablePoint(Number(value.lat), Number(value.lon));
}

export function exportableRecords(records) {
  return records.map((record) => {
    const out = {};
    for (const field of EXPORT_FIELDS) {
      if (record[field] !== undefined) out[field] = record[field];
    }
    if (out.transmitted !== undefined) out.transmitted = boundaryPoint(out.transmitted);
    // Nested objects are REBUILT, not carried over. Copying `timing` and `tiers` wholesale meant the
    // allowlist stopped at the top level: anything a caller nested inside them travelled out
    // untouched, which is the same failure the allowlist exists to prevent, one level down.
    if (out.timing !== undefined) out.timing = exportableTiming(out.timing);
    if (out.tiers !== undefined) out.tiers = exportableTiers(out.tiers);
    out.result = exportableResult(record.result);
    return out;
  });
}
