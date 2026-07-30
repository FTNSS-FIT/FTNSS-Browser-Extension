// The recorder. This is browser-owned extension UI, NOT a panel injected into the listing page.
//
// The page cannot hide it, cannot move it, cannot swallow its clicks, and cannot watch what is typed
// into it. That matters most for the two things this UI is for: displaying the "could not read this
// page" state, whose whole value is that its absence is not something a page can arrange, and taking
// the person's verdict, which is the ground truth the entire measurement rests on.
//
// No network request is made anywhere in this file.

import {
  loadRecords,
  clearRecords,
  saveRecord,
  exportableRecords,
  currentReading,
  clearCurrentReading,
  currentCohort,
  setCurrentCohort,
  cohortRecordFor,
  SITE_LABELS,
} from '../lib/storage.js';
import { toTransmittablePoint, distanceMetres } from '../lib/geo.js';

const readingEl = document.getElementById('reading');
const controlsEl = document.getElementById('controls');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function describe(result) {
  if (result?.status === 'found') {
    // Two decimals for every classification. Three is ~100m, which is a precision claim, and no
    // read here has established that much.
    const tag = result.precision === 'approximate' ? 'approximate' : 'precision unverified';
    return `Tier ${result.tier} · ~${result.lat.toFixed(2)}, ${result.lon.toFixed(2)} · ${tag}`;
  }
  if (result?.status === 'found_address') return 'Tier 3 · address only, not geocoded';
  return 'No read — could not read this page';
}

async function refreshCount() {
  const records = await loadRecords();
  countEl.textContent = `${records.length} recorded`;
}

async function renderCohort() {
  const cohortEl = document.getElementById('cohort');
  cohortEl.replaceChildren();
  const selected = await currentCohort();

  const select = document.createElement('select');
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Choose the site you are measuring…';
  select.appendChild(blank);
  for (const label of SITE_LABELS) {
    const option = document.createElement('option');
    option.value = label;
    option.textContent = label;
    if (label === selected) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', async () => {
    if (select.value) await setCurrentCohort(select.value);
    await render();
  });
  cohortEl.appendChild(select);
  return selected;
}

async function render() {
  controlsEl.replaceChildren();
  statusEl.replaceChildren();
  const cohort = await renderCohort();
  const reading = await currentReading();

  if (reading == null) {
    readingEl.className = 'muted';
    readingEl.textContent =
      'No reading for this page. Open a listing on a supported site, or reload the tab.';
    await refreshCount();
    return;
  }

  readingEl.replaceChildren();
  readingEl.className = '';
  const summary = el('div');
  summary.appendChild(el('code', describe(reading.result)));
  readingEl.appendChild(summary);

  const t = reading.tiers ?? {};
  readingEl.appendChild(
    el(
      'div',
      `t1 ${t.tier1 === 'found' ? '✓' : '·'}  t2 ${t.tier2 === 'found' ? '✓' : '·'}  t3 ${
        t.tier3 === 'found_address' ? '✓' : '·'
      }`,
      'muted',
    ),
  );

  // The declared cohort is what gets recorded, so a mismatch would silently file this reading under
  // the wrong site — which would corrupt the one comparison the phase exists to make. The check is
  // done here, in the browser, and the detected value is never written anywhere.
  const mismatch = cohort != null && reading.detectedSite !== 'other' && reading.detectedSite !== cohort;
  if (mismatch) {
    readingEl.appendChild(
      el('div', `⚠ this page looks like ${reading.detectedSite}, not ${cohort}`, 'warn'),
    );
  }

  // NOT "time until the person saw it". The popup opens whenever it is clicked, which could be
  // seconds later, and folding that in would measure the operator rather than the page. This is
  // page-ready → reading available: the pipeline latency the product's own panel would inherit.
  // (Codex review round 9, PR #1.)
  const latency = reading.timing?.readingReadyMs;
  const worstCase = latency == null ? null : latency + (reading.latencyUncertaintyMs ?? 0);
  readingEl.appendChild(
    el(
      'div',
      `extract ${reading.timing?.totalMs ?? '?'}ms · reading ready ${
        worstCase == null ? 'unmeasured' : `≤${Math.round(worstCase)}ms`
      }`,
      worstCase != null && worstCase > 800 ? 'warn' : 'muted',
    ),
  );
  if (reading.domSettled === false) {
    readingEl.appendChild(el('div', '⚠ page had not settled', 'warn'));
  }

  const hasCoordinate = reading.result?.status === 'found';
  let precisionVerdict = 'not_assessed';

  if (hasCoordinate) {
    const row = el('div', null, 'row');
    row.appendChild(el('span', 'Point is:', 'muted'));
    const buttons = [];
    for (const [label, value] of [
      ['Building', 'building'],
      ['Area', 'area'],
      ['Unclear', 'unclear'],
    ]) {
      const b = el('button', label);
      b.addEventListener('click', () => {
        precisionVerdict = value;
        for (const other of buttons) other.className = '';
        b.className = 'primary';
      });
      buttons.push(b);
      row.appendChild(b);
    }
    controlsEl.appendChild(row);
  }

  const truth = el('input');
  truth.placeholder = 'Ground truth "lat, lon" (optional)';
  if (hasCoordinate) controlsEl.appendChild(truth);

  async function record(verdict) {
    if (cohort == null) {
      statusEl.replaceChildren(el('span', 'Choose the site you are measuring first.', 'warn'));
      return;
    }
    if (mismatch) {
      statusEl.replaceChildren(
        el('span', 'Cohort does not match this page — fix it before recording.', 'warn'),
      );
      return;
    }
    if (verdict === 'not_a_listing') {
      // A dismissal, not a datum — a non-listing must not enter the denominator.
      await clearCurrentReading();
      await render();
      return;
    }

    let errorMetres = null;
    const raw = truth.value.trim();
    if (raw && hasCoordinate) {
      const parts = raw.split(',').map((p) => Number(p.trim()));
      if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        errorMetres = Math.round(
          distanceMetres({ lat: reading.result.lat, lon: reading.result.lon }, { lat: parts[0], lon: parts[1] }),
        );
      }
    }

    // RE-READ AND REVALIDATE before writing anything.
    //
    // `reading` was captured when the popup rendered. A popup can stay open across a soft
    // navigation, and the controls rendered for listing A remained live and clickable after the
    // person had moved to listing B — so a verdict meant for B could be written against A's
    // coordinates. Session storage being invalidated did not help, because the closure still held
    // the old object. Check that the reading is still there AND still the same one.
    // (Codex review round 12, PR #1.)
    const live = await currentReading();
    if (live == null || live.publishedAt !== reading.publishedAt || live.navigationId !== reading.navigationId) {
      statusEl.replaceChildren(
        el('span', 'This page changed since the reading — nothing recorded.', 'warn'),
      );
      await render();
      return;
    }

    await saveRecord({
      // The family and variant the operator DECLARED — never a hostname.
      ...cohortRecordFor(cohort),
      // Date only. A precise time beside a site label is the makings of a browsing log, and nothing
      // in the report groups more finely than a day.
      recordedAt: new Date().toISOString().slice(0, 10),
      verdict,
      precisionVerdict,
      softNavigation: reading.softNavigation === true,
      domSettled: reading.domSettled !== false,
      latencyUncertaintyMs: reading.latencyUncertaintyMs ?? 0,
      timing: reading.timing,
      tiers: reading.tiers,
      errorMetres,
      result: reading.result,
      transmitted: hasCoordinate ? toTransmittablePoint(reading.result.lat, reading.result.lon) : null,
    });

    // Clearing the reading is also the dedup: one record per page view, and the popup then reports
    // that there is nothing to record until the next navigation republishes.
    await clearCurrentReading();
    statusEl.replaceChildren(el('span', `Recorded: ${verdict}`, 'ok'));
    await render();
  }

  const options = hasCoordinate
    ? [
        ['Correct', 'correct', true],
        ['Wrong', 'wrong', false],
        ["Can't tell", 'unverifiable', false],
      ]
    : [
        ['Confirm no read', 'no_read', true],
        ["Can't tell", 'unverifiable', false],
      ];
  options.push(['Not a listing', 'not_a_listing', false]);

  const row = el('div', null, 'row');
  for (const [label, verdict, primary] of options) {
    const b = el('button', label, primary ? 'primary' : null);
    b.addEventListener('click', () => void record(verdict));
    row.appendChild(b);
  }
  controlsEl.appendChild(row);

  await refreshCount();
}

function download(records, suffix) {
  if (records.length === 0) return;
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ftnss-phase1-${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
  // The anchor must be in the document for the click to start a download in every browser, and the
  // object URL must outlive the click — revoking it synchronously can cancel the handoff.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

document.getElementById('export').addEventListener('click', async () => {
  download(exportableRecords(await loadRecords()), 'measurements');
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearRecords();
  await render();
});

void render();
