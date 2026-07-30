// Popup — shows how many listings have been recorded, and exports them.
//
// The export is a local file download built from an in-memory blob. There is no upload, no sync,
// and no network request anywhere in this file.

import { loadRecords, clearRecords, redactRecords } from '../lib/storage.js';

const countEl = document.getElementById('count');

async function refresh() {
  const records = await loadRecords();
  countEl.textContent = `${records.length} recorded`;
  return records;
}

async function download(records, suffix) {
  if (records.length === 0) return;
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Save into the gitignored measurements/ directory. The name carries the date so successive
  // exports do not silently overwrite one another.
  a.download = `ftnss-phase1-${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
  // Anchor must be in the document for the click to start a download in every browser, and the
  // object URL must outlive the click — revoking it synchronously afterwards can cancel the
  // download that has only just been handed off.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// The shareable one is the default. It carries the verdicts, tiers, timings and rounded points the
// report is computed from, and none of the URLs, addresses or notes — so it can be passed around
// without passing a browsing session around with it.
document.getElementById('export').addEventListener('click', async () => {
  download(redactRecords(await loadRecords()), 'redacted');
});

// The full export stays available because verifying a disputed reading means returning to the
// listing. It is the deliberate exception described in AGENTS.md, not an oversight.
document.getElementById('export-full').addEventListener('click', async () => {
  download(await loadRecords(), 'full');
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearRecords();
  await refresh();
});

refresh();
