// Local measurement storage.
//
// NO PAGE IDENTIFIER IS STORED. Not the URL, not the hostname, not the address text.
//
// An earlier version kept the URL so a disputed reading could be re-checked against the listing it
// came from, and argued the case as a bounded exception. That was wrong twice over: it put a
// browsing trail on disk, and the way it was defended — by writing a carve-out into the rules file —
// disarmed the reviewer that would have caught the next one. The rule is absolute; the instrument
// had to change instead. (Codex review round 3, PR #1.)
//
// What replaced it:
//   • nothing derived from the URL is persisted at all, not even a hash (see below);
//   • the site is a label chosen from OUR OWN allowlist, not `location.hostname`, so no page can put
//     text into it;
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
 * Publish the reading for the page on screen.
 *
 * It goes through the service worker rather than straight to storage, so the reading is keyed by a
 * tab id the content script cannot choose. The projection here is not incidental: the popup used to
 * receive the full extraction, which carried the page URL and, for a tier-3 read, the address text
 * off the page — while the popup told the person no URL or page text was stored. Sending only what
 * the popup renders makes the claim true at the source instead of relying on a later filter.
 * (Codex review round 9, PR #1.)
 */
export async function publishReading(reading) {
  const result = reading.result ?? null;
  await chrome.runtime.sendMessage({
    type: 'FTNSS_READING',
    reading: {
      // The detected site is sent so the popup can WARN when it disagrees with the cohort the
      // operator declared. It is never persisted — see COHORTS below.
      detectedSite: reading.site,
      // No `identity`, and no address text. The popup renders neither, and the surest way for a
      // value not to leak is for it never to be sent.
      result:
        result == null
          ? null
          : {
              status: result.status,
              tier: result.tier ?? null,
              precision: result.precision ?? null,
              ...(result.status === 'found' ? { lat: result.lat, lon: result.lon } : {}),
            },
      tiers: reading.tiers,
      timing: reading.timing,
      softNavigation: reading.softNavigation,
      domSettled: reading.domSettled,
      latencyUncertaintyMs: reading.latencyUncertaintyMs,
    },
  });
}

/**
 * Drop the tab's reading immediately, without waiting to publish a replacement.
 *
 * Called the moment a soft navigation is detected. Remeasuring is asynchronous and a soft navigation
 * fires no browser-level load event, so without this the previous listing's reading stayed live —
 * and recordable — for as long as the settle wait took.
 */
export async function invalidateReading() {
  await chrome.runtime.sendMessage({ type: 'FTNSS_INVALIDATE' });
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
  const bag = await chrome.storage.local.get(COHORT_KEY);
  return typeof bag?.[COHORT_KEY] === 'string' ? bag[COHORT_KEY] : null;
}

export async function setCurrentCohort(cohort) {
  if (!SITE_LABELS.includes(cohort)) throw new Error('unknown cohort');
  await chrome.storage.local.set({ [COHORT_KEY]: cohort });
}

/** The reading for the tab the person is looking at — never a global "last page published". */
export async function currentReading() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return null;
  const bag = await chrome.storage.session.get(`reading:${tab.id}`);
  return bag?.[`reading:${tab.id}`] ?? null;
}

export async function clearCurrentReading() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  await chrome.storage.session.remove(`reading:${tab.id}`);
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
  const [stored] = exportableRecords([record]);
  const trimmed = [...records, stored].slice(-MAX_RECORDS);
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
  'cohort', // declared by the operator; never derived from the page
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
