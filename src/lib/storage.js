// Local measurement storage.
//
// WHY THE URL IS STORED HERE AND NOWHERE ELSE. The shipped extension never records a URL at all.
// This harness does, for one reason: a measurement is worthless without ground truth, and checking
// whether an extracted point is actually right means being able to go back to the listing. So the
// URL is kept — in chrome.storage.local, on the machine that did the browsing, never transmitted,
// and exported only by an explicit click to a directory that is gitignored.
//
// This is a deliberate, bounded exception for a development tool that is never published, and it is
// the reason `measurements/` is gitignored rather than merely untracked. When the harness is
// retired the exception goes with it. No code path in this file, or reachable from it, performs a
// network request.

const KEY = 'phase1_records';
const MAX_RECORDS = 500;

export async function loadRecords() {
  const bag = await chrome.storage.local.get(KEY);
  const records = bag?.[KEY];
  return Array.isArray(records) ? records : [];
}

export async function saveRecord(record) {
  const records = await loadRecords();
  // One record per listing URL. Re-recording a page you have already done replaces the old entry
  // rather than counting the same listing twice, which would quietly weight the sample.
  const withoutDuplicate = records.filter((r) => r.url !== record.url);
  withoutDuplicate.push(record);
  const trimmed = withoutDuplicate.slice(-MAX_RECORDS);
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed.length;
}

export async function clearRecords() {
  await chrome.storage.local.remove(KEY);
}

/**
 * Fields that identify or reproduce the page. Everything the phase-1 REPORT needs is outside this
 * list — the numbers are computed from verdicts, tiers, timings and rounded points, none of which
 * say which listing anyone looked at.
 */
const PAGE_IDENTIFYING = ['url', 'note', 'groundTruth', 'errorMetres'];

/**
 * A copy with the page-identifying fields removed, and coordinates reduced to what the product would
 * actually transmit.
 *
 * The full export exists because a measurement cannot be verified without being able to return to
 * the listing. But a file that reproduces a browsing session should not be the one that gets
 * attached to a message or dropped in a shared folder, and the way to prevent that is to make the
 * safe artifact the convenient one rather than to rely on everyone remembering which is which.
 * (Codex review round 2, PR #1.)
 */
export function redactRecords(records) {
  return records.map((record) => {
    const copy = { ...record };
    for (const field of PAGE_IDENTIFYING) delete copy[field];
    if (copy.result?.status === 'found') {
      // Rounded to transmission precision — the report's accuracy figures come from the verdict,
      // not from re-deriving position, so nothing is lost that the decision depends on.
      copy.result = { ...copy.result, lat: undefined, lon: undefined };
    }
    if (copy.result?.status === 'found_address') {
      // The address is page content. The report only needs to know one was present.
      copy.result = { ...copy.result, address: undefined };
    }
    return copy;
  });
}
