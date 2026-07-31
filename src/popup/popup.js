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
  loadEndpoint,
  saveEndpoint,
  endpointProblem,
} from '../lib/storage.js';
import {
  TRANSMIT_KM,
  toTransmittablePoint,
  distanceMetres,
  parseCoordinate,
  isUsableCoordinate,
} from '../lib/geo.js';
import { gymsNear, describeDistance } from '../lib/proximity.js';

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

/**
 * Show which build is running.
 *
 * Reloading an unpacked extension gives no confirmation that anything changed, and half a dozen
 * times during the first sessions a fix was pushed, reloaded, and the old behaviour persisted —
 * with no way to tell a failed reload from a failed fix. Read from the manifest at runtime rather
 * than written here, so it cannot drift from what the browser actually loaded.
 */
function showVersion() {
  // Defensive on purpose. This runs FIRST in start(), so anything that throws here takes the whole
  // popup down before it renders — which is precisely how the popup died four times already. A
  // cosmetic label must never be able to do that.
  try {
    const element = document.getElementById('version');
    if (element == null) return;
    element.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    // A missing version display is a nuisance; a blank popup is a broken instrument.
  }
}

async function refreshCount() {
  const records = await loadRecords();
  countEl.textContent = `${records.length} recorded`;
}

/**
 * Bounded re-checks while a reading is still settling, with the progress shown as it goes.
 *
 * These four were referenced throughout and never declared — the popup threw
 * `MAX_POLLS is not defined` on every page. Four wiring bugs of this shape have now shipped from
 * this file, every one of them a scripted edit that silently matched nothing. The executable smoke
 * test added alongside this is the actual fix; the declarations are just the symptom.
 */
const MAX_POLLS = 20;
const POLL_INTERVAL_MS = 400;
let pollsRemaining = MAX_POLLS;
let pollTimer = null;

/** A message that must survive the re-render which follows it. */
let pendingNotice = null;

async function render() {
  controlsEl.replaceChildren();
  statusEl.replaceChildren();
  if (pendingNotice != null) {
    statusEl.appendChild(el('span', pendingNotice, 'warn'));
    pendingNotice = null;
  }
  // Read the page as it is right now, retrying while the content script may still be attaching.
  readingEl.className = 'muted';
  readingEl.textContent = 'reading the page…';
  // Long enough to cover the SLOWEST attachment actually measured — 5.8 seconds on a Booking page,
  // where 12 attempts at 300ms covered only 3.3 and gave up while the page was still coming up. A
  // retry budget shorter than the thing it retries for is a retry that reports a false negative.
  let reading = await readActivePage({ attempts: 30, intervalMs: 300 });

  if (reading == null) {
    readingEl.className = 'muted';
    // Says which of the two it is. "No reading for this page" covered both a page we do not measure
    // and a page that simply had not finished loading, and they need different responses from the
    // person holding the instrument.
    readingEl.textContent =
      'Nothing here to read. Either this is not a listing on a site we measure, or the page is still loading — reload and try again.';
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

  // STILL SETTLING — SHOWN, NOT BLOCKING.
  //
  // This used to return before rendering any controls, so while the page was settling there was no
  // Log button at all. On a site whose address appears at 600ms and whose coordinate never appears,
  // that is five seconds of an instrument that will not let you record anything, with no indication
  // of how long it intends to keep you waiting.
  //
  // The reason the block existed is still valid — logging "nothing found" on a page whose
  // coordinate is a second away writes a false miss. But the answer is to SHOW the state and let the
  // person decide, not to take the button away: they are looking at the page and can see whether it
  // has finished loading. The record carries whether it had settled, so the report can separate them.
  let recorded = false;
  const settling = reading.provisional === true;
  const progressEl = el('div', null, 'muted');
  readingEl.appendChild(progressEl);

  if (settling) {
    // POLL WITHOUT REBUILDING THE CONTROLS.
    //
    // The poll used to call render(), which begins by replacing every child of the controls — so on
    // a page that never settles, the Log button was destroyed and rebuilt every 400ms, and a click
    // landing in the wrong 400ms window hit a button that no longer existed. Clicking Log did
    // nothing, repeatedly, with no error, which is the worst possible failure for a button whose
    // entire job is to be pressed.
    //
    // Only the progress line updates now. A full re-render happens ONLY when the outcome category
    // changes, because that is when a different set of controls genuinely applies.
    const startedAt = Date.now();
    const tick = async () => {
      if (recorded) return;
      const latest = await readActivePage();
      if (latest == null || latest.pageToken !== reading.pageToken) return;

      if (latest.result?.status !== reading.result?.status) {
        pollsRemaining = MAX_POLLS;
        await render();
        return;
      }

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (pollsRemaining > 0 && latest.provisional === true) {
        pollsRemaining -= 1;
        progressEl.textContent = `still reading… ${seconds}s — a coordinate may still appear`;
        pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      } else {
        progressEl.className = 'warn';
        progressEl.textContent = 'stopped waiting — this is what the page gives us. Logging it is fine.';
      }
    };
    progressEl.textContent = 'still reading… 0.0s — a coordinate may still appear';
    pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
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
  const truthFeedback = el('div', null, 'muted');

  if (hasCoordinate) {
    controlsEl.appendChild(truth);
    controlsEl.appendChild(truthFeedback);

    // SHOW THE DISTANCE THE MOMENT IT CAN BE COMPUTED.
    //
    // Without this the person judges by eye, and by eye a pin that sits slightly off looks wrong.
    // It happened on the first verified reading: a coordinate was marked WRONG whose measured error
    // was 42 metres — inside the 500m grid cell, so literally invisible after rounding, and
    // irrelevant against a 5km search radius. One record, and it drove the reported wrong-rate to
    // 100%.
    //
    // The instrument was asking for a judgement it had all the information to inform, and didn't.
    // (Jordan's first verification session.)
    truth.addEventListener('input', () => {
      const raw = truth.value.trim();
      if (raw === '') {
        truthFeedback.className = 'muted';
        truthFeedback.textContent = '';
        return;
      }
      const groundTruth = parseGroundTruth(raw);
      if (groundTruth == null) {
        truthFeedback.className = 'muted';
        truthFeedback.textContent = 'waiting for "lat, lon"…';
        return;
      }
      const point = { lat: reading.result.lat, lon: reading.result.lon };
      const metres = Math.round(distanceMetres(point, groundTruth));

      // COMPARE THE ROUNDED POINTS. "Smaller than the cell means rounding erases it" is FALSE, and
      // provably so: two points ONE METRE apart either side of a cell boundary round into different
      // cells and end up 333m apart. Cell size bounds the error rounding ADDS; it says nothing about
      // whether a particular pair survives it. Only rounding both and comparing answers that.
      // (Codex review, PR #8.)
      const roundedRead = toTransmittablePoint(point.lat, point.lon);
      const roundedTruth = toTransmittablePoint(groundTruth.lat, groundTruth.lon);
      const sameCell =
        roundedRead != null &&
        roundedTruth != null &&
        roundedRead.lat === roundedTruth.lat &&
        roundedRead.lon === roundedTruth.lon;
      const afterRounding =
        roundedRead && roundedTruth ? Math.round(distanceMetres(roundedRead, roundedTruth)) : null;

      // NEUTRAL ABOVE ONE CELL.
      //
      // Calling anything up to a kilometre "adjacent" and "small" was wrong twice: a kilometre spans
      // four 250m cells, and near the edge of a 5km search it can change which gyms appear at all.
      // Worse, it was leading the operator toward "correct" — and their verdict is the ground truth
      // the whole measurement rests on, so nudging it corrupts the one thing we cannot recompute.
      // State the distances; let them judge. (Codex review, PR #8.)
      const cells = afterRounding == null ? null : Math.round(afterRounding / (TRANSMIT_KM * 1000));
      if (sameCell) {
        truthFeedback.className = 'ok';
        truthFeedback.textContent = `${metres}m out — rounds into the same cell, so this is a match.`;
      } else {
        truthFeedback.className = 'muted';
        truthFeedback.textContent =
          `${metres}m out, ${afterRounding}m after rounding — ${cells} cell${cells === 1 ? '' : 's'} away. Your call.`;
      }
    });
  }

  async function log({ notAListing = false } = {}) {
    if (recorded) return; // one record per popup opening
    // Stop re-reading: a refresh mid-log would replace the controls under the person's hands.
    if (pollTimer != null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
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
    // underneath can navigate in that time.
    const fresh = await readActivePage();
    if (fresh == null) {
      statusEl.replaceChildren(el('span', 'Could not read the page — nothing logged.', 'warn'));
      return;
    }

    // NAVIGATION is what must block a save. A DIFFERENT READING IS NOT.
    //
    // The check used to refuse whenever the fresh extraction differed from the displayed one, which
    // made Log do nothing on exactly the pages that need it most: while a page is still settling the
    // extraction changes every few hundred milliseconds — that is what "still reading" means — so
    // every click was refused as though the person had navigated. And the refusal called render(),
    // which clears the status line it had just written, so it failed silently.
    //
    // The opaque page token changes only on navigation, so that is the right discriminator. A
    // changed reading on the SAME page means the page finished loading, and the fresh one is the
    // truer record — so we log that rather than the stale snapshot.
    if (fresh.pageToken !== reading.pageToken) {
      statusEl.replaceChildren(
        el('span', 'The page changed while the popup was open — nothing logged.', 'warn'),
      );
      return;
    }

    // One exception: if the person judged a coordinate and the coordinate has since moved, their
    // judgement is about a point that no longer exists. Re-render so they can look again.
    if (verified != null && !sameReading(fresh, reading)) {
      pendingNotice = 'The page finished loading and the reading changed — check it and log again.';
      await render();
      return;
    }

    // Log what the page says NOW.
    reading = fresh;

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
        // Whether the page had finished settling when this was logged. A reading taken while a
        // coordinate might still have appeared is usable but weaker, and the report says so rather
        // than mixing it in silently.
        // Derived from the read we are ACTUALLY logging, not from the render-time snapshot. The
        // page may have finished settling between the popup opening and the click — using the
        // stale value marked those records unsettled when they were not, which is the same class
        // of error as logging the stale reading itself. (Codex review, PR #6.)
        settled: fresh.provisional !== true,
        precisionVerdict,
        timing: reading.timing,
        tiers: reading.tiers,
        addressComponents: reading.addressComponents ?? null,
        errorMetres,
        result: reading.result,
        // Recomputed from the reading we are actually logging, not from the render-time snapshot.
        transmitted:
          reading.result?.status === 'found'
            ? toTransmittablePoint(reading.result.lat, reading.result.lon)
            : null,
      });
    } catch (err) {
      statusEl.replaceChildren(el('span', err?.message ?? 'Could not save.', 'warn'));
      return;
    }

    recorded = true;
    const what = reading.result?.status === 'found' ? 'coordinate' : reading.result?.status ?? 'nothing';
    controlsEl.replaceChildren(
      el('div', `Logged: ${what}${verified ? ` (${verified})` : ''}${settling ? ' — while still settling' : ''}`, 'ok'),
    );
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
/**
 * The panel, such as it is.
 *
 * IN THE POPUP, NOT INJECTED INTO THE PAGE, and that is the significant decision here rather than
 * anything about the layout. The content script's stated invariant is that it renders nothing and
 * publishes nothing — it reads the DOM on demand and answers. Injecting a panel would end that:
 * our markup would live inside a document we treat as adversarial, inheriting its CSS, visible to
 * its scripts, and mutating a page the person did not ask us to change.
 *
 * The cost is that this is a click away instead of in front of them, which is a product question
 * for a later phase and reversible. The invariant is not reversible once given up.
 */
async function renderGyms() {
  const container = document.getElementById('gyms');
  // Defensive for the same reason showVersion() is: this runs unawaited at startup, so anything it
  // throws surfaces as an unhandled rejection with no obvious link to the recorder — and the
  // recorder is the part that must not break. A missing node means a markup change, not a crash.
  if (container == null) return;
  const endpoint = await loadEndpoint();

  const say = (message, className = 'muted') =>
    container.replaceChildren(el('div', message, className));

  if (endpoint == null) {
    say('No endpoint set yet.');
    container.appendChild(endpointForm(''));
    return;
  }

  const reading = await readActivePage();
  const result = reading?.result;
  if (result?.status !== 'found') {
    // Honest about WHICH of the two reasons applies. "No gyms" and "we could not read this page"
    // look identical in a panel and mean opposite things — one is about our supply, the other
    // about our extractor — and conflating them is how a coverage problem gets misdiagnosed as a
    // reading problem for a month.
    say(result?.status === 'found_address'
      ? 'This page gave an address but no coordinates, and there is no geocoder yet.'
      : 'Nothing to search from — no coordinate read on this page.');
    return;
  }

  say('Searching…');
  const answer = await gymsNear({ lat: result.lat, lon: result.lon }, { endpoint });

  if (answer.status === 'unconfigured') return say('No endpoint set yet.');
  if (answer.status === 'error') {
    // One sentence for every failure. Which of them it was is our business, not the page's.
    say('Could not reach FTNSS.', 'warn');
    container.appendChild(el('div', answer.reason, 'muted'));
    return;
  }
  if (answer.status === 'empty') {
    // NOT AN ERROR, and worded so nobody reads it as one. This is the true answer nearly
    // everywhere until supply grows, and a panel that cries failure over its most common correct
    // response teaches people to ignore it.
    // "of the area searched", not "of here". The query point is a 250m cell, not the hotel.
    say('No FTNSS gyms within 5km of the area searched.');
    return;
  }

  container.replaceChildren();
  for (const gym of answer.gyms) {
    const row = el('div', null, 'gym');
    const left = el('div');
    left.appendChild(el('b', gym.name));
    if (gym.city) left.appendChild(el('div', gym.city, 'muted'));
    row.appendChild(left);
    row.appendChild(el('span', describeDistance(gym.distanceMetres), 'dist'));
    container.appendChild(row);
  }
  // SAY WHAT THE DISTANCES ARE MEASURED FROM, and say it differently when the reading itself was
  // approximate. Tier 2 reads a map pin rather than a published point and is labelled `approximate`
  // for that reason — stacking an approximate reading under a 250m grid and then printing a
  // confident distance is precisely the compounding this repo refuses to do elsewhere.
  const approximate = result.precision === 'approximate';
  container.appendChild(
    el(
      'div',
      approximate
        ? `${answer.gyms.length} nearest — distances are rough: this page gave an approximate location, rounded to a 250m cell`
        : `${answer.gyms.length} nearest, measured from a 250m cell — distances are approximate`,
      approximate ? 'warn' : 'muted',
    ),
  );
}

/** Set or change the endpoint, and ask for that origin's permission at the same time. */
function endpointForm(current) {
  const wrap = el('div');
  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://…/api/proximity';
  input.value = current;
  wrap.appendChild(input);

  const row = el('div', null, 'row');
  const save = el('button', 'Save endpoint', 'primary');
  const note = el('span', null, 'muted');
  save.addEventListener('click', async () => {
    const value = input.value.trim();
    const problem = value.length === 0 ? null : endpointProblem(value);
    if (problem != null) {
      note.textContent = problem;
      note.className = 'warn';
      return;
    }
    // ASK FOR THIS ORIGIN ONLY, at the moment a person names it.
    //
    // The alternative was a compiled-in host permission, which means the install prompt lists a
    // host before anyone has decided which environment we call — and a broad one to cover the
    // choice. Requesting the origin the person just typed is both narrower and more truthful.
    if (value.length > 0) {
      const origin = `${new URL(value).origin}/*`;
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        note.textContent = 'Permission declined, so it was not saved.';
        note.className = 'warn';
        return;
      }
    }
    try {
      await saveEndpoint(value);
    } catch (err) {
      note.textContent = err?.message ?? 'Could not save that.';
      note.className = 'warn';
      return;
    }
    await renderGyms();
  });
  row.appendChild(save);
  row.appendChild(note);
  wrap.appendChild(row);
  return wrap;
}

async function start() {
  showVersion();
  await migrateAwayLocalCohort();
  await migrateStoredRecords();
  await render();
  // AFTER the recorder renders, and not awaited alongside it. This one makes a network call, and
  // the measurement UI must never wait on the network to appear.
  void renderGyms();
}

void start();
