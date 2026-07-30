// The measurement recorder panel.
//
// This is NOT the product panel — it is the instrument. It shows what the extractors read and asks
// the person browsing to say whether that is right, which is the only way to tell a correct read
// from a confidently wrong one.
//
// Every node here is built with createElement and textContent. There is no innerHTML anywhere in
// this file, and there must never be: this panel displays strings taken straight out of a hostile
// page, inside an extension context.

const HOST_ID = 'ftnss-phase1-recorder';

function el(tag, text, style) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (style) node.setAttribute('style', style);
  return node;
}

const CSS = `
  :host { all: initial; }
  .box {
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    width: 300px; max-height: 80vh; overflow: auto;
    font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
    background: #14161a; color: #f2f3f5;
    border: 1px solid #2c3038; border-radius: 10px;
    padding: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
  }
  h1 { font-size: 12px; margin: 0 0 8px; letter-spacing: .04em; text-transform: uppercase; color: #8b93a1; }
  .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  button {
    font: inherit; cursor: pointer; border-radius: 6px;
    border: 1px solid #3a4049; background: #1e2229; color: #f2f3f5; padding: 5px 9px;
  }
  button:hover { background: #262b33; }
  button.primary { background: #FF4D1C; border-color: #FF4D1C; color: #fff; }
  code { font-family: ui-monospace, monospace; color: #9fd0ff; overflow-wrap: anywhere; }
  .muted { color: #8b93a1; }
  .warn { color: #ffb26b; }
  .ok { color: #7ee08a; }
  input {
    font: inherit; width: 100%; box-sizing: border-box; margin-top: 6px;
    background: #0e1013; color: #f2f3f5; border: 1px solid #3a4049; border-radius: 6px; padding: 5px 7px;
  }
  .saved { margin-top: 8px; }
`;

function describe(result) {
  if (result.status === 'found') {
    return `Tier ${result.tier} · ${result.lat.toFixed(5)}, ${result.lon.toFixed(5)}`;
  }
  if (result.status === 'found_address') {
    return `Tier 3 · address only, not geocoded`;
  }
  return 'No read';
}

/**
 * @param {object} opts
 * @param {ReturnType<import('../extract/index.js').runExtraction>} opts.extraction
 * @param {number|null} opts.readyToPanelMs  null after a soft navigation — there is no new
 *        navigation entry to measure against, and a fabricated number is worse than none
 * @param {string} opts.capturedUrl
 * @param {(verdict: object) => Promise<void>} opts.onSave
 */
export function mountRecorder({ extraction, readyToPanelMs, capturedUrl, onSave }) {
  document.getElementById(HOST_ID)?.remove();

  const host = el('div');
  host.id = HOST_ID;
  // Closed shadow root: the page cannot reach into the panel's DOM, and the page's CSS cannot
  // restyle it into something misleading.
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const box = el('div', null, null);
  box.className = 'box';
  root.appendChild(box);

  box.appendChild(el('h1', 'FTNSS phase 1 — measurement'));

  const summary = el('div');
  summary.appendChild(el('code', describe(extraction.result)));
  box.appendChild(summary);

  if (extraction.result.status === 'found_address') {
    const addressLine = el('div', extraction.result.address);
    addressLine.className = 'muted';
    box.appendChild(addressLine);
  }

  // Which listing this reading belongs to. Shown because the panel survives soft navigation and a
  // reading is bound to the URL it was taken on, not to whatever the address bar says now.
  const urlLine = el('div', capturedUrl.replace(/^https?:\/\//, '').slice(0, 60));
  urlLine.className = 'muted';
  box.appendChild(urlLine);

  const tiers = extraction.tiers;
  const tierLine = el(
    'div',
    `t1 ${tiers.tier1.status === 'found' ? '✓' : '·'}  ` +
      `t2 ${tiers.tier2.status === 'found' ? '✓' : '·'}  ` +
      `t3 ${tiers.tier3.status === 'found_address' ? '✓' : '·'}`,
  );
  tierLine.className = 'muted';
  box.appendChild(tierLine);

  const overBudget =
    (readyToPanelMs != null && readyToPanelMs > 800) || extraction.timing.totalMs > 150;
  const timing = el(
    'div',
    `extract ${extraction.timing.totalMs}ms · ready→panel ` +
      (readyToPanelMs == null ? 'n/a (soft nav)' : `${Math.round(readyToPanelMs)}ms`),
  );
  timing.className = overBudget ? 'warn' : 'muted';
  box.appendChild(timing);

  // Precision is OBSERVED, not inferred. The extractor used to label every tier-1 read 'exact',
  // which on a site that publishes a deliberately fuzzed point would have recorded every listing as
  // building-accurate. Whether a point is the building or an area is exactly what this phase is
  // here to find out, so the person looking at the page says. (Codex review, PR #1.)
  let precisionVerdict = 'not_assessed';
  const hasCoordinate = extraction.result.status === 'found';

  if (hasCoordinate) {
    const precisionRow = el('div');
    precisionRow.className = 'row';
    const precisionLabel = el('span', 'Point is:');
    precisionLabel.className = 'muted';
    precisionRow.appendChild(precisionLabel);
    const choices = [
      ['Building', 'building'],
      ['Area', 'area'],
      ['Unclear', 'unclear'],
    ];
    const buttons = [];
    for (const [label, value] of choices) {
      const b = el('button', label);
      b.addEventListener('click', () => {
        precisionVerdict = value;
        for (const other of buttons) other.className = '';
        b.className = 'primary';
      });
      buttons.push(b);
      precisionRow.appendChild(b);
    }
    box.appendChild(precisionRow);
  }

  const truth = el('input');
  truth.placeholder = 'Ground truth "lat, lon" (optional)';
  box.appendChild(truth);

  const note = el('input');
  note.placeholder = 'Note (optional)';
  box.appendChild(note);

  const status = el('div', '');
  status.className = 'saved';

  async function record(verdict) {
    status.className = 'saved muted';
    status.textContent = 'Saving…';
    try {
      await onSave({
        verdict,
        precisionVerdict,
        groundTruthRaw: truth.value.trim(),
        note: note.value.trim(),
      });
      status.className = 'saved ok';
      status.textContent = `Recorded: ${verdict}`;
    } catch (err) {
      status.className = 'saved warn';
      status.textContent = `Not saved: ${err && err.name ? err.name : 'error'}`;
    }
  }

  const buttons = el('div');
  buttons.className = 'row';
  // Correct/Wrong are only offered when there IS a coordinate to judge. Previously a person could
  // mark an address-only or failed read "correct", and the report counted it as a hit — inflating
  // the one number the phase-1 decision is made on. Make the incorrect input unavailable rather than
  // filtering it out later. (Codex review, PR #1.)
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
  for (const [label, verdict, primary] of options) {
    const button = el('button', label);
    if (primary) button.className = 'primary';
    button.addEventListener('click', () => record(verdict));
    buttons.appendChild(button);
  }
  box.appendChild(buttons);
  box.appendChild(status);

  const dismiss = el('button', 'Hide');
  dismiss.addEventListener('click', () => host.remove());
  const dismissRow = el('div');
  dismissRow.className = 'row';
  dismissRow.appendChild(dismiss);
  box.appendChild(dismissRow);

  document.documentElement.appendChild(host);
}
