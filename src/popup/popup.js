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
  cohortRecordFor,
  siteLabelFor,
  migrateAwayLocalCohort,
  migrateStoredRecords,
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

async function render() {
  controlsEl.replaceChildren();
  statusEl.replaceChildren();
  // Read the page as it is right now.
  const reading = await readActivePage();

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

  // WHY each tier gave up, shown whenever nothing was found. "No read" on its own tells the person
  // holding the instrument nothing about whether the site is unreadable or the harness is broken,
  // and they are the one who can tell the difference by looking at the page.
  if (reading.result?.status !== 'found') {
    const t1 = reading.tiers?.tier1Reason;
    const t2 = reading.tiers?.tier2Reason;
    const t3 = reading.tiers?.tier3Reason;
    for (const [label, reason] of [['t1', t1], ['t2', t2], ['t3', t3]]) {
      if (reason) readingEl.appendChild(el('div', `${label}: ${reason}`, 'muted'));
    }
  }

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

  // DETECTED, not declared. Asking the operator to select the site, then export, clear and switch
  // between sites, was the most error-prone part of the protocol — every step a chance to mislabel
  // or lose a batch — and an instrument whose workflow is annoying produces worse data than one
  // whose workflow is boring. The page already knows which site it is. (DECISIONS 11.)
  const detected = reading.detectedHost ? siteLabelFor(reading.detectedHost) : 'other';
  const cohortEl = document.getElementById('cohort');
  cohortEl.replaceChildren(el('div', detected === 'other' ? 'not a listed site' : detected, 'muted'));

  if (reading.provisional === true) {
    // Still working out whether the page is readable. Shown, so the operator knows the extension is
    // alive, and not recordable — "no read" here would write a false miss for a page whose
    // coordinates are about to appear.
    //
    // AND WE COME BACK. Rendering once and returning left the popup saying "still reading" forever:
    // the content script settled a second later and nothing asked it again, so that listing could
    // never be recorded at all. The pages that take a moment to settle are the slow, heavy ones, so
    // silently losing them raises the measured hit rate — the same direction as every other defect
    // this instrument has had. (Codex review rounds 24 and 25, PR #1.)
    readingEl.appendChild(el('div', 'still reading this page…', 'muted'));
    await refreshCount();
    if (pollsRemaining > 0) {
      pollsRemaining -= 1;
      setTimeout(() => void render(), 400);
    } else {
      readingEl.appendChild(el('div', 'This page did not settle. Reload it and try again.', 'warn'));
    }
    return;
  }

  const hasCoordinate = reading.result?.status === 'found';
  let precisionVerdict = 'not_assessed';
  let verified = null;

  // LOG IS THE PRIMARY ACTION, AND IT ASKS NOTHING.
  //
  // The extractor already knows what it found — a coordinate, an address, a contradiction, nothing.
  // Making the person restate that was friction carrying no information, and friction in a
  // measurement instrument costs sample size, which is the one thing this phase cannot buy back.
  //
  // What a person uniquely knows is whether a coordinate is the RIGHT PLACE, and that question only
  // exists when there is a coordinate. So it is optional and separate: log everything cheaply, and
  // verify a subsample. The report keeps the two apart and states each N, because an extraction rate
  // measured over 100 pages and a correctness rate measured over 12 are different numbers and must
  // never be quoted as one. (Jordan, after the first session.)
  if (hasCoordinate) {
    const precisionRow = el('div', null, 'row');
    precisionRow.appendChild(el('span', 'Optional — point is:', 'muted'));
    const precisionButtons = [];
    for (const [label, value] of [
      ['Building', 'building'],
      ['Area', 'area'],
      ['Unclear', 'unclear'],
    ]) {
      const button = el('button', label);
      button.addEventListener('click', () => {
        precisionVerdict = value;
        for (const other of precisionButtons) other.className = '';
        button.className = 'primary';
      });
      precisionButtons.push(button);
      precisionRow.appendChild(button);
    }
    controlsEl.appendChild(precisionRow);

    const verifyRow = el('div', null, 'row');
    verifyRow.appendChild(el('span', 'Optional — is it right?', 'muted'));
    const verifyButtons = [];
    for (const [label, value] of [
      ['Correct', 'correct'],
      ['Wrong', 'wrong'],
    ]) {
      const button = el('button', label);
      button.addEventListener('click', () => {
        verified = value;
        for (const other of verifyButtons) other.className = '';
        button.className = 'primary';
      });
      verifyButtons.push(button);
      verifyRow.appendChild(button);
    }
    controlsEl.appendChild(verifyRow);
  }

  const truth = el('input');
  truth.placeholder = 'Optional — ground truth "lat, lon"';
  if (hasCoordinate) controlsEl.appendChild(truth);

  let recorded = false;
  async function log({ notAListing = false } = {}) {
    if (recorded) return; // one record per popup opening
    if (detected === 'other') {
      statusEl.replaceChildren(el('span', 'This is not one of the listed sites.', 'warn'));
      return;
    }
    if (notAListing) {
      // A dismissal, not a datum — a non-listing must not enter the denominator.
      recorded = true;
      controlsEl.replaceChildren(el('div', 'Skipped — not a listing.', 'muted'));
      return;
    }

    // Re-read immediately before saving: the popup stays open while the person decides, and the page
    // underneath can navigate in that time. Compared on an opaque per-page token and the extraction
    // itself, so neither side handles a URL.
    const fresh = await readActivePage();
    if (fresh == null || fresh.pageToken !== reading.pageToken || !sameReading(fresh, reading)) {
      statusEl.replaceChildren(
        el('span', 'This page changed while the popup was open — nothing recorded.', 'warn'),
      );
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
          el('span', 'Ground truth must be "lat, lon" and in range — nothing logged.', 'warn'),
        );
        return;
      }
      errorMetres = Math.round(
        distanceMetres({ lat: reading.result.lat, lon: reading.result.lon }, groundTruth),
      );
    }

    try {
      await saveRecord({
        // Family and variant, DETECTED from the page. Harness only — see DECISIONS 11.
        ...cohortRecordFor(detected),
        // Date only. A precise time beside a site label is the makings of a browsing log, and
        // nothing in the report groups more finely than a day.
        recordedAt: new Date().toISOString().slice(0, 10),
        // WHAT THE EXTRACTOR FOUND — mechanical, always present, the high-volume measure.
        outcome: reading.result?.status ?? 'not_found',
        // WHETHER A PERSON CHECKED IT — null when nobody did, which is the common case by design.
        verified,
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

    recorded = true;
    const what = reading.result?.status === 'found' ? 'coordinate' : reading.result?.status ?? 'nothing';
    controlsEl.replaceChildren(el('div', `Logged: ${what}${verified ? ` (${verified})` : ''}`, 'ok'));
    statusEl.replaceChildren(el('span', 'Open the popup again on the next listing.', 'muted'));
    await refreshCount();
  }

  const row = el('div', null, 'row');
  const logButton = el('button', 'Log', 'primary');
  logButton.addEventListener('click', () => void log());
  row.appendChild(logButton);
  const skipButton = el('button', 'Not a listing');
  skipButton.addEventListener('click', () => void log({ notAListing: true }));
  row.appendChild(skipButton);
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
  // ONE FILE for the whole session, both sites. Each record carries its own family and variant, so
  // the report splits it — no export/clear/switch dance between sites.
  download(exportableRecords(await loadRecords()), 'session');
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearRecords();
  await render();
});

/**
 * Sanitise anything an older build left on disk, BEFORE the first render.
 *
 * Legacy rows were only rewritten on the next successful save — and the two states where saving is
 * refused, an orphaned batch and a full store, are exactly the states an abandoned old batch is
 * likely to be in. So a browsing trail could sit in local storage indefinitely while the popup said
 * none was stored, with no path that would ever clean it. Migration cannot depend on a later write
 * succeeding. (Codex review round 25, PR #1.)
 */
async function start() {
  await migrateAwayLocalCohort();
  await migrateStoredRecords();
  await render();
}

void start();
