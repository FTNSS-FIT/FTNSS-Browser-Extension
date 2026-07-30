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
