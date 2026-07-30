// The recorder. Browser-owned extension UI, not a panel injected into the listing page.
//
// The page cannot hide it, move it, swallow its clicks, or watch what is typed into it. That matters
// for the two things it does: showing the "could not read this page" state, whose whole value is
// that its absence cannot be arranged by the page, and taking the person's verdict, which is the
// ground truth the entire measurement rests on.
//
// It reads the page ON OPEN. There is no stored reading to go stale, so there is nothing to
// revalidate, no navigation to detect, and no window in which this can show one listing's
// coordinates while another is on screen.
//
// No network request is made anywhere in this file.

import {
  loadRecords,
  clearRecords,
  saveRecord,
  exportableRecords,
  readActivePage,
  currentCohort,
  setCurrentCohort,
  batchCohortLabel,
  clearBatchCohortLabel,
  siteLabelFor,
  migrateAwayLocalCohort,
  SITE_LABELS,
} from '../lib/storage.js';
import { toTransmittablePoint, distanceMetres, parseCoordinate, isUsableCoordinate } from '../lib/geo.js';

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

/**
 * Ground truth, parsed strictly.
 *
 * `Number()` turned "38.7115," into (38.7115, 0) — Null Island, silently — and accepted "91,0",
 * which is not a latitude. Both would have entered the positional-error statistics as though they
 * were readings, corrupting the one number that says whether a correct-LOOKING coordinate is
 * actually correct.
 */
function parseGroundTruth(raw) {
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lat = parseCoordinate(parts[0].trim());
  const lon = parseCoordinate(parts[1].trim());
  return isUsableCoordinate(lat, lon) ? { lat, lon } : null;
}

/** Is this the same extraction the person formed their verdict from? */
function sameReading(a, b) {
  const ra = a?.result ?? {};
  const rb = b?.result ?? {};
  if (ra.status !== rb.status || (ra.tier ?? null) !== (rb.tier ?? null)) return false;
  if (ra.status === 'found') return ra.lat === rb.lat && ra.lon === rb.lon;
  return true;
}

function describe(result) {
  if (result?.status === 'found') {
    // Two decimals whatever the classification. Three is ~100m, which is a precision claim, and no
    // read here has established that much.
    const tag = result.precision === 'approximate' ? 'approximate' : 'precision unverified';
    return `Tier ${result.tier} · ~${result.lat.toFixed(2)}, ${result.lon.toFixed(2)} · ${tag}`;
  }
  if (result?.status === 'found_address') return 'Tier 3 · address only, not geocoded';
  if (result?.status === 'ambiguous') return 'Ambiguous — the page disagreed with itself';
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

  // Read the page as it is right now.
  const reading = await readActivePage();

  // Records outlive a browser restart; the batch label does not, because it is session-scoped so no
  // site string is ever written to disk. That combination would let a new cohort's readings be mixed
  // into an old batch that can no longer be identified — so recording stops until the batch is
  // exported and cleared. Exporting still works, which is the way out. (Codex review round 22, PR #1.)
  const orphanedBatch = (await loadRecords()).length > 0 && (await batchCohortLabel()) == null;
  if (orphanedBatch) {
    readingEl.className = 'warn';
    readingEl.textContent =
      'There are records from a previous session whose cohort label is gone. Export and clear them before recording more.';
    controlsEl.replaceChildren();
    await refreshCount();
    return;
  }

  if (reading == null) {
    readingEl.className = 'muted';
    readingEl.textContent =
      'No reading for this page. Open a listing on one of the sites in the manifest, or reload the tab.';
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

  const latency = reading.timing?.readingReadyMs;
  readingEl.appendChild(
    el(
      'div',
      `extract ${reading.timing?.totalMs ?? '?'}ms · reading ready ${
        latency == null ? 'unmeasured' : `${latency}ms`
      }`,
      latency != null && latency > 800 ? 'warn' : 'muted',
    ),
  );

  // The declared cohort is what gets recorded, so a mismatch would file this reading under the wrong
  // site and corrupt the one comparison this phase exists to make. Checked here, in the browser; the
  // detected host is never written anywhere.
  const detected = reading.detectedHost ? siteLabelFor(reading.detectedHost) : 'other';
  const mismatch = cohort != null && detected !== 'other' && detected !== cohort;
  if (mismatch) {
    readingEl.appendChild(el('div', `⚠ this page looks like ${detected}, not ${cohort}`, 'warn'));
  }

  if (reading.provisional === true) {
    // Still working out whether the page is readable. Shown, so the operator knows the extension is
    // alive, and not recordable — "no read" here would write a false miss for a page whose
    // coordinates are about to appear.
    readingEl.appendChild(el('div', 'still reading this page…', 'muted'));
    await refreshCount();
    return;
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
      const button = el('button', label);
      button.addEventListener('click', () => {
        precisionVerdict = value;
        for (const other of buttons) other.className = '';
        button.className = 'primary';
      });
      buttons.push(button);
      row.appendChild(button);
    }
    controlsEl.appendChild(row);
  }

  const truth = el('input');
  truth.placeholder = 'Ground truth "lat, lon" (optional)';
  if (hasCoordinate) controlsEl.appendChild(truth);

  let recorded = false;
  async function record(verdict) {
    if (recorded) return; // one record per popup opening

    // RE-READ IMMEDIATELY BEFORE SAVING.
    //
    // The popup stays open while the person decides, and the page underneath it can navigate in that
    // time — `pushState` needs no reload and announces nothing. Reading on demand removed the stale
    // STORED reading, but the reading held in this closure is a snapshot too, and a verdict formed
    // for listing A must not be written against whatever is on screen now.
    //
    // The comparison is on an opaque per-page token, so neither side handles a URL.
    // (Codex review round 22, PR #1.)
    const fresh = await readActivePage();
    // Compare the READING, not only the token. The token changes with the URL, so a page that
    // replaces listing A's DOM with listing B at the SAME url kept a valid token while everything
    // it described had changed — and A's coordinate could be recorded as correct for B. Comparing
    // what was actually extracted covers both, and needs no URL on either side.
    // (Codex review round 23, PR #1.)
    if (fresh == null || fresh.pageToken !== reading.pageToken || !sameReading(fresh, reading)) {
      statusEl.replaceChildren(
        el('span', 'This page changed while the popup was open — nothing recorded.', 'warn'),
      );
      await render();
      return;
    }
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
      await render();
      return;
    }

    let errorMetres = null;
    const raw = truth.value.trim();
    if (raw && hasCoordinate) {
      const groundTruth = parseGroundTruth(raw);
      if (groundTruth == null) {
        // Refuse VISIBLY. Silently ignoring unparseable input means the person believes they
        // supplied ground truth while the statistics quietly disagree.
        statusEl.replaceChildren(
          el('span', 'Ground truth must be "lat, lon" and in range — nothing recorded.', 'warn'),
        );
        return;
      }
      errorMetres = Math.round(
        distanceMetres({ lat: reading.result.lat, lon: reading.result.lon }, groundTruth),
      );
    }

    try {
      await saveRecord({
        // NOTHING about the site. Not the hostname, not a family, not a variant — a coarse label
        // beside a date still proves which domain was visited, because recording is refused unless
        // the declared cohort matches the page. The cohort lives in the export filename instead.
        // (Codex review round 21, PR #1.)
        // Date only. A precise time beside a site label is the makings of a browsing log, and
        // nothing in the report groups more finely than a day.
        recordedAt: new Date().toISOString().slice(0, 10),
        verdict,
        precisionVerdict,
        timing: reading.timing,
        tiers: reading.tiers,
        errorMetres,
        result: reading.result,
        transmitted: hasCoordinate
          ? toTransmittablePoint(reading.result.lat, reading.result.lon)
          : null,
      });
    } catch (err) {
      statusEl.replaceChildren(el('span', err?.message ?? 'Could not save.', 'warn'));
      return;
    }

    // Records carry no identifier by design, so a duplicate cannot be detected or removed later.
    // The controls therefore have to stop being clickable rather than the data being cleaned up
    // afterwards — there is no afterwards. (Codex review round 21, PR #1.)
    recorded = true;
    controlsEl.replaceChildren(el('div', `Recorded: ${verdict}`, 'ok'));
    statusEl.replaceChildren(
      el('span', 'Open the popup again to record the next listing.', 'muted'),
    );
    await refreshCount();
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
    const button = el('button', label, primary ? 'primary' : null);
    button.addEventListener('click', () => void record(verdict));
    row.appendChild(button);
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
  // NEUTRAL FILENAME. Putting the cohort here moved the leak rather than removing it: a file called
  // `ftnss-phase1-airbnb.jp-...json` sitting in a directory IS the browsing record the row
  // projection exists to prevent, and it is more durable than the rows because it survives being
  // opened, copied and attached. The person exporting knows which batch they just exported; the
  // report takes the label as an argument when they run it. (Codex review round 22, PR #1.)
  download(exportableRecords(await loadRecords()), 'batch');
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearRecords();
  await clearBatchCohortLabel();
  await render();
});

void migrateAwayLocalCohort();
void render();
