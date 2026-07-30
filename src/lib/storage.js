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
//   • the cohort is DECLARED by the operator and stored as a family and a variant, never a hostname;
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

/**
 * What actually gets RECORDED for a cohort: the family, and whether it was the primary domain or a
 * country-code variant. Never the hostname itself.
 *
 * Making the operator declare the cohort fixed its provenance but not its CONTENT: `airbnb.jp` is
 * still a hostname, and because recording is blocked unless the declaration matches the page, an
 * export carrying it still proves which domain was visited. The popup's "no hostname is stored" was
 * therefore false, which is a claim defect on top of the privacy one.
 *
 * `{family: 'airbnb', variant: 'cctld'}` answers the question this phase actually asks — *do
 * country-code domains behave differently from the primary one?* — without recording which country.
 * The specific domain is only ever compared in the browser and never written down.
 * (Codex review round 12, PR #1.)
 */
export function cohortRecordFor(label) {
  const family = siteFamilyFor(label);
  const primary = family === 'airbnb' ? 'airbnb.com' : family === 'booking' ? 'booking.com' : null;
  return { family, variant: label === primary ? 'primary' : 'cctld' };
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
  if (records.length >= MAX_RECORDS) {
    throw new Error(`storage is full (${MAX_RECORDS} records) — export and clear before continuing`);
  }
  const trimmed = exportableRecords([...records, record]);
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed.length;
}

// exportableRecords is defined below and used by saveRecord above — the SAME projection on both
// sides, so what is stored and what is exported can never drift apart.

export async function clearRecords() {
  await chrome.storage.local.remove(KEY);
}

/**
 * The exact set of fields an exported record may contain — an ALLOWLIST, so a field added later is
 * withheld until someone decides it belongs, rather than shipped because nobody remembered it.
 * Every entry here is either a number we computed or a value chosen from our own vocabulary.
 */
const EXPORT_FIELDS = [
  'family', // 'airbnb' | 'booking' — declared by the operator, never a hostname
  'variant', // 'primary' | 'cctld' — answers the ccTLD question without naming the country
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

/** The result, reduced to what the report reads: never a coordinate, never page text. */
function exportableResult(result) {
  if (result == null) return null;
  return {
    status: result.status,
    tier: result.tier ?? null,
    precision: result.precision ?? null,
    // `source` is a fixed vocabulary set by the extractors, but it is rebuilt here rather than
    // copied so that a future extractor cannot widen what leaves this module by widening its own
    // string. Anything unrecognised becomes 'other'.
    source: typeof result.source === 'string' && result.source.length <= 40 ? result.source : 'other',
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
    out.result = exportableResult(record.result);
    return out;
  });
}
