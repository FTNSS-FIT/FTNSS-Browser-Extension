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
  matchPatternFor,
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
import { gymUrl } from '../lib/locale.js';

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

/** A tier answered if it produced a point or an address; only tier 2 can never produce the latter. */
const answered = (status) => status === 'found' || status === 'found_address';

function describe(result) {
  if (result?.status === 'found') {
    // Two decimals whatever the classification. Three is ~100m, which is a precision claim, and no
    // read here has established that much.
    const tag = result.precision === 'approximate' ? 'approximate' : 'precision unverified';
    return `Tier ${result.tier} · ~${result.lat.toFixed(2)}, ${result.lon.toFixed(2)} · ${tag}`;
  }
  // `result.tier`, NOT a hardcoded 3. Tier 1 now answers with an address too, and the whole reason
  // the operator is shown a tier is so a wrong reading can be traced to the thing that produced it.
  // Labelling every address "Tier 3" would have made the Expedia fix unverifiable from the popup.
  if (result?.status === 'found_address') {
    return `Tier ${result.tier ?? '?'} · address only, not geocoded`;
  }
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
  // START THE READ, DO NOT WAIT FOR IT.
  //
  // The retry budget below is 9 seconds, sized for the slowest content-script attachment actually
  // measured — 5.8s on a Booking page. Awaiting it here meant the popup rendered NOTHING for those
  // 9 seconds on any page where the script never attaches at all, which is every page that is not a
  // listing: a new tab, GitHub, anything. The common case was paying the worst case's budget, and
  // the symptom was a popup that looked frozen and was simply waiting.
  //
  // The budget is right and the awaiting was wrong. Everything below paints straight away and the
  // reading fills itself in when it arrives — which also means a slow Booking page now shows its
  // gyms panel and its record count immediately instead of a blank rectangle.
  readingEl.className = 'muted';
  readingEl.textContent = 'reading the page…';
  const readingPromise = readActivePage({ attempts: 30, intervalMs: 300 });

  // The rest of the popup does not depend on the page, so it should never wait on it.
  await refreshCount();
  void renderGymsIdle();

  let reading = await readingPromise;

  if (reading == null) {
    readingEl.className = 'muted';
    // Says which of the two it is. "No reading for this page" covered both a page we do not measure
    // and a page that simply had not finished loading, and they need different responses from the
    // person holding the instrument.
    readingEl.textContent =
      'Nothing here to read. Either this is not a listing on a site we measure, or the page is still loading — reload and try again.';
    // Count and gyms panel are already on screen — painted before this read was awaited.
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
      // A tier ANSWERED if it produced either a point or an address. Checking tier 1 for 'found'
      // alone left it showing a dot on the very pages the address path was added for.
      `t1 ${answered(t.tier1) ? '✓' : '·'}  t2 ${answered(t.tier2) ? '✓' : '·'}  t3 ${
        answered(t.tier3) ? '✓' : '·'
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

      // sameReading, not a status comparison. Tier 3 finding an address first and tier 1 catching
      // up leaves the status identical and the TIER different, so the panel went on showing
      // "Tier 3" while Log stored tier 1 — the operator verifying one reading and recording
      // another. sameReading already compares tier and coordinates; it just was not being used.
      if (!sameReading(latest, reading)) {
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
/**
 * Which lookup is current.
 *
 * A lookup can take four seconds, and changing or clearing the endpoint starts another immediately
 * — so the older request would finish last and render gyms from an endpoint that had already been
 * replaced, or from one that had been cleared entirely. The panel would be showing an answer to a
 * question nobody was asking any more, which is the same class of error as rendering listing A's
 * gyms under listing B, arriving from the same direction: time.
 */
let lookupGeneration = 0;
/** The lookup currently in flight, so a new one can cancel it rather than race it. */
let inFlight = null;

/**
 * The resting state: an endpoint is configured and NOTHING has been sent.
 *
 * Opening the popup used to fire a lookup immediately, which contradicted the README's own promise
 * — "one request is made, and only if you ask for gyms" — for the most ordinary reason anyone opens
 * this build, which is to log or export a measurement. A privacy claim the code breaks on the
 * common path is not a bug in the wording.
 *
 * It also made a network request a side effect of a toolbar click, and the panel is the one place
 * this extension does anything a user did not directly ask for.
 */
async function renderGymsIdle() {
  // INVALIDATE ANYTHING IN FLIGHT. Returning to this view is a statement that the previous question
  // no longer applies — the endpoint changed, or was cleared — and without bumping the generation a
  // four-second-old lookup finished afterwards and painted stale gyms, or a false "none found",
  // over the resting state. The guard existed; the path back to idle simply never armed it.
  lookupGeneration += 1;
  inFlight?.abort();
  inFlight = null;
  const container = document.getElementById('gyms');
  if (container == null) return;
  const endpoint = await loadEndpoint();
  container.replaceChildren();

  if (endpoint == null) {
    container.appendChild(el('div', 'No endpoint set yet.', 'muted'));
  } else {
    container.appendChild(
      el('div', 'Nothing has been sent. Looking up gyms sends one rounded coordinate.', 'muted'),
    );
  }

  const row = el('div', null, 'row');
  if (endpoint != null) {
    const find = el('button', 'Find gyms', 'primary');
    find.addEventListener('click', () => { void renderGyms(); });
    row.appendChild(find);
  }
  const change = el('button', endpoint == null ? 'Set endpoint' : 'Change endpoint');
  change.addEventListener('click', () => {
    lookupGeneration += 1;
    container.replaceChildren(endpointForm(endpoint ?? ''));
  });
  row.appendChild(change);
  container.appendChild(row);
}

async function renderGyms() {
  // ONE AT A TIME. Bumping the generation invalidates the previous lookup's renders, but the
  // request it already sent keeps running — so this aborts it too, rather than leaving a
  // coordinate in flight that nobody will ever look at.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const generation = (lookupGeneration += 1);
  const container = document.getElementById('gyms');
  // Defensive for the same reason showVersion() is: this runs unawaited at startup, so anything it
  // throws surfaces as an unhandled rejection with no obvious link to the recorder — and the
  // recorder is the part that must not break. A missing node means a markup change, not a crash.
  if (container == null) return;
  const endpoint = await loadEndpoint();

  // THE FORM IS ALWAYS REACHABLE, and it used to appear only when no endpoint was set — so a typo,
  // a revoked permission or a change of environment left the feature permanently broken with no way
  // back through the UI. A setting you can write once and never correct is a trap, and the state it
  // traps you in is the one where something is already wrong.
  // Every write to the panel checks it is still the current lookup. A guard placed only around the
  // network call would still let a stale error or empty state paint over a fresh one.
  const stale = () => generation !== lookupGeneration;
  const say = (message, className = 'muted') => {
    if (stale()) return;
    container.replaceChildren(el('div', message, className));
    const row = el('div', null, 'row');
    const again = el('button', 'Look again');
    again.addEventListener('click', () => { void renderGyms(); });
    row.appendChild(again);
    const change = el('button', endpoint == null ? 'Set endpoint' : 'Change endpoint');
    change.addEventListener('click', () => {
      lookupGeneration += 1;
      row.replaceChildren(endpointForm(endpoint ?? ''));
    });
    row.appendChild(change);
    container.appendChild(row);
  };

  if (endpoint == null) {
    say('No endpoint set yet.');
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

  // CHECK AGAIN IMMEDIATELY BEFORE SENDING. The generation guard stopped stale answers being
  // RENDERED, which is not the same as stopping them being ASKED — a double-click, or Look again
  // during a search, or changing the endpoint while the page read was still pending, each fired
  // another request. In a panel whose privacy claim is "one request, only when you ask", quietly
  // sending two coordinates because a button was pressed twice is the wrong kind of extra.
  if (stale()) return;

  say('Searching…');
  const answer = await gymsNear(
    { lat: result.lat, lon: result.lon },
    { endpoint, signal: controller.signal },
  );

  // THE PAGE MAY HAVE MOVED WHILE WE WERE ASKING.
  //
  // The read happens once and the request can run for four seconds — an eternity on a site that
  // navigates without reloading, which is every site in the manifest. Listing A's gyms rendered
  // under listing B is a confidently wrong answer of exactly the kind the extraction tiers refuse
  // to produce, arriving through the one door they do not watch: time.
  //
  // `pageToken` is the same identity the recorder uses to refuse a stale Log, so the panel and the
  // measurement agree on what "this page" means.
  const after = await readActivePage();
  if (
    after?.pageToken !== reading.pageToken ||
    after?.result?.status !== 'found' ||
    after.result.lat !== result.lat ||
    after.result.lon !== result.lon
  ) {
    say('The page changed while we were looking. Open the panel again.');
    return;
  }

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
    //
    // BUT AN ABSENCE IS A STRONGER CLAIM THAN A PRESENCE, so it needs the same caveat the results
    // list carries — and it was returning before the precision check that adds it. A tier-2 read is
    // a map pin, not a published point, and "no gyms within 5km" measured from a pin that may be
    // somewhere else is a false negative delivered with total confidence. The one thing worse than
    // failing to find a gym is telling someone there isn't one.
    //
    // "of the area searched", not "of here": the query point is a 250m cell, not the hotel.
    // NEVER CONCLUSIVE, whatever the precision. We searched around a point whose accuracy we have
    // not established, rounded to a 250m cell — so "there are none" is a claim the evidence cannot
    // carry in either case. It only gets weaker when the site publishes an area by design.
    say(result.precision === 'approximate'
      ? 'No FTNSS gyms found within 5km of the area searched — and this page publishes only an approximate location, so treat that as inconclusive.'
      : 'No FTNSS gyms found within 5km of the area searched — measured from a rounded point, so not conclusive.');
    return;
  }

  if (stale()) return;
  // NO READING HERE IS VERIFIED. This split used to be "approximate versus everything else", which
  // quietly treated `unknown` as precise — and `unknown` is what tier 1 deliberately reports,
  // because whether a published point is the building or a fuzzed area is a per-site fact this
  // project measures rather than assumes. There is no 'exact' in the vocabulary at all, on purpose.
  const approximate = result.precision === 'approximate';
  container.replaceChildren();
  for (const gym of answer.gyms) {
    const row = el('div', null, 'gym');
    const left = el('div');
    // A LINK ONLY IF ONE CAN BE BUILT SAFELY. gymUrl refuses anything that is not a site-relative
    // path under the gym directory, and refuses a locale it cannot confirm the site serves — both
    // failures returning null rather than a guess. A gym with no link is a small loss; a gym with
    // the wrong link is the entire problem, because the panel is the part a person trusts.
    const href = gymUrl(gym.path, endpoint);
    if (href == null) {
      left.appendChild(el('b', gym.name));
    } else {
      const link = document.createElement('a');
      link.textContent = gym.name;
      link.href = href;
      link.target = '_blank';
      // noopener because the opened page gets window.opener otherwise and can navigate us; noreferrer
      // so the hotel page we were on is not announced to our own site.
      link.rel = 'noopener noreferrer';
      link.className = 'gymlink';
      left.appendChild(link);
    }
    if (gym.city) left.appendChild(el('div', gym.city, 'muted'));
    row.appendChild(left);
    // NO DISTANCE AT ALL. Not for approximate reads, not for `unknown` ones — which is every other
    // read, because `unknown` is what tier 1 reports and there is no `exact` in this codebase.
    //
    // Bands were the third attempt and still could not be made true: the query point is a 250m
    // cell, so a server distance of 499m can be ~674m from the listing, and "under 500 m" is then
    // simply false. Each version was less wrong than the last while the real problem stayed put —
    // we do not know how far away these gyms are, and no phrasing fixes that.
    //
    // The ordering carries the useful part, and it survives the uncertainty: nearest first is still
    // nearest first when every distance is shifted by the same cell offset. (Codex, PR #13.)
    container.appendChild(row);
  }
  // SAY WHAT THE DISTANCES ARE MEASURED FROM, and say it differently when the reading itself was
  // approximate. Tier 2 reads a map pin rather than a published point and is labelled `approximate`
  // for that reason — stacking an approximate reading under a 250m grid and then printing a
  // confident distance is precisely the compounding this repo refuses to do elsewhere.

  const change = el('button', 'Change endpoint');
  change.addEventListener('click', () => {
    lookupGeneration += 1;
    container.replaceChildren(endpointForm(endpoint));
  });
  const changeRow = el('div', null, 'row');
  changeRow.appendChild(change);

  container.appendChild(
    el(
      'div',
      approximate
        ? `${answer.gyms.length} nearest first — this page publishes only an approximate location, so treat the order loosely`
        : `${answer.gyms.length} nearest first — distances not shown: we search from a 250m cell, so we cannot state one honestly`,
      approximate ? 'warn' : 'muted',
    ),
  );
  container.appendChild(changeRow);
}

/**
 * Hand back the old origin's permission, unless the new endpoint still needs it.
 *
 * Best effort and deliberately non-fatal: failing to return a permission is untidy, while refusing
 * to save a working endpoint over it would be worse.
 */
async function releaseOrigin(previous, next) {
  const old = matchPatternFor(previous);
  if (old == null || old === matchPatternFor(next)) return;
  try {
    // `remove` RESOLVES FALSE when it declines rather than throwing, so catching alone left a
    // silent failure looking identical to success. There is nothing to do about it in the UI —
    // the endpoint is saved and works — but a console line is the difference between a stale
    // permission being discoverable and being invisible.
    const removed = await chrome.permissions.remove({ origins: [old] });
    if (!removed) console.warn(`FTNSS: could not release ${old}; it remains authorised`);
  } catch (err) {
    console.warn(`FTNSS: could not release ${old}`, err?.message ?? err);
  }
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
  const clear = el('button', 'Clear');
  const note = el('span', null, 'muted');
  clear.addEventListener('click', async () => {
    // Saving an empty value removes it. Worth an explicit button rather than relying on someone
    // discovering that emptying the field and saving is the way out.
    const previous = await loadEndpoint();
    await saveEndpoint('');
    await releaseOrigin(previous, '');
    await renderGymsIdle();
  });
  save.addEventListener('click', async () => {
    const value = input.value.trim();
    /** Set once a new origin has actually been granted, so a later failure can hand it back. */
    let grantedPattern = null;
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
      // WRAPPED. Chrome REJECTS this call for an origin the manifest does not declare, rather than
      // resolving false — and the rejection was outside any catch, so the click died silently and
      // the person was left looking at a form that had apparently done nothing. A validation
      // that leaves no visible error is the same as no validation.
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [matchPatternFor(value)] });
      } catch (err) {
        note.textContent = `Chrome refused that origin: ${err?.message ?? 'unknown error'}`;
        note.className = 'warn';
        return;
      }
      if (!granted) {
        note.textContent = 'Permission declined, so it was not saved.';
        note.className = 'warn';
        return;
      }
      grantedPattern = matchPatternFor(value);
    }
    // GIVE BACK WHAT WE NO LONGER NEED. Switching from localhost to production left both origins
    // authorised forever, which contradicts the single-origin design the manifest exists to state.
    // Best effort and deliberately non-fatal: failing to hand a permission back is untidy, while
    // refusing to save a working endpoint over it would be worse.
    const previous = await loadEndpoint();
    try {
      await saveEndpoint(value);
    } catch (err) {
      // ROLL THE GRANT BACK. Storage failing after the permission was granted left the extension
      // holding access to an origin it had no endpoint for and no UI to reach — a permission the
      // person agreed to for a setting that does not exist.
      if (grantedPattern != null && grantedPattern !== matchPatternFor(previous)) {
        try {
          await chrome.permissions.remove({ origins: [grantedPattern] });
        } catch {
          // Nothing further to try; the message below is still the important part.
        }
      }
      note.textContent = err?.message ?? 'Could not save that.';
      note.className = 'warn';
      return;
    }
    // COMPARE ORIGINS, NOT URLS. Comparing the full URL meant changing only the PATH — the most
    // likely edit anyone makes — saved the new endpoint and then revoked the permission it needs,
    // breaking the feature through the act of correcting it.
    await releaseOrigin(previous, value);
    await renderGymsIdle();
  });
  row.appendChild(save);
  row.appendChild(clear);
  row.appendChild(note);
  wrap.appendChild(row);
  return wrap;
}

async function start() {
  showVersion();
  await migrateAwayLocalCohort();
  await migrateStoredRecords();
  // render() paints the gyms panel itself, before it awaits the page read — so there is nothing to
  // schedule here. It makes NO network request either way; that happens only on Find gyms.
  await render();
}

void start();
