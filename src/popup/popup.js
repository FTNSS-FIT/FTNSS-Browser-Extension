// Popup — shows how many listings have been recorded, and exports them.
//
// The export is a local file download built from an in-memory blob. There is no upload, no sync,
// and no network request anywhere in this file.

import { loadRecords, clearRecords } from '../lib/storage.js';

const countEl = document.getElementById('count');

async function refresh() {
  const records = await loadRecords();
  countEl.textContent = `${records.length} recorded`;
  return records;
}

document.getElementById('export').addEventListener('click', async () => {
  const records = await loadRecords();
  if (records.length === 0) return;
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Save into the gitignored measurements/ directory. The name carries the date so successive
  // exports do not silently overwrite one another.
  a.download = `ftnss-phase1-${new Date().toISOString().slice(0, 10)}.json`;
  // Anchor must be in the document for the click to start a download in every browser, and the
  // object URL must outlive the click — revoking it synchronously afterwards can cancel the
  // download that has only just been handed off.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearRecords();
  await refresh();
});

refresh();
