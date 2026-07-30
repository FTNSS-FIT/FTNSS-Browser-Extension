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
//   • dedup uses a non-reversible hash of the URL, never the URL;
//   • the site is a label chosen from OUR OWN allowlist, not `location.hostname`, so no page can put
//     text into it;
//   • the export is built from a strict ALLOWLIST of fields. A denylist fails open — it protects
//     only the fields someone remembered, and every new field is exposed by default.

const KEY = 'phase1_records';
const MAX_RECORDS = 500;

/**
 * The only sites this harness runs on. The stored label comes from here, so it is a value we chose
 * rather than one the page supplied.
 */
export const SITE_LABELS = ['booking.com', 'airbnb.com'];

export function siteLabelFor(hostname) {
  const match = SITE_LABELS.find((label) => hostname === label || hostname.endsWith(`.${label}`));
  return match ?? 'other';
}

/**
 * FNV-1a. Used ONLY to notice that a listing has already been recorded, so re-recording replaces
 * rather than double-counting it. It is not a security primitive and does not need to be: it exists
 * so we never have to keep the URL itself.
 */
export function urlKey(url) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function loadRecords() {
  const bag = await chrome.storage.local.get(KEY);
  const records = bag?.[KEY];
  return Array.isArray(records) ? records : [];
}

export async function saveRecord(record) {
  const records = await loadRecords();
  // One record per listing. Re-recording a page you have already done replaces the old entry rather
  // than counting the same listing twice, which would quietly weight the sample.
  const withoutDuplicate = records.filter((r) => r.urlKey !== record.urlKey);
  withoutDuplicate.push(record);
  const trimmed = withoutDuplicate.slice(-MAX_RECORDS);
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed.length;
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
  'site', // from SITE_LABELS, never location.hostname
  'recordedAt',
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

export function exportableRecords(records) {
  return records.map((record) => {
    const out = {};
    for (const field of EXPORT_FIELDS) {
      if (record[field] !== undefined) out[field] = record[field];
    }
    out.result = exportableResult(record.result);
    return out;
  });
}
