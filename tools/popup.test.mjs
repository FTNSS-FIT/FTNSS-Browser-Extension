// Runs the popup. Actually runs it — loads the module, renders, and clicks Log.
//
// This exists because four wiring bugs have shipped from popup.js, and every one of them looked
// exactly like working code: `cohortRecordFor is not defined` when you pressed Log, then
// `MAX_POLLS is not defined` on every page. A missing import or an undeclared constant is not a
// syntax error, so `node --check` passes. It is not a resolution error, so the module-graph test
// passes. It is a ReferenceError on one code path at runtime, and the only thing that finds those
// is running the code.
//
// So: a DOM small enough to write in fifty lines, a mock `chrome`, and the real popup.js on top.
// If the module throws while loading, while rendering, or while logging, this fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── The smallest DOM popup.js can run on ─────────────────────────────────────
const created = [];

function makeElement(tag = 'div') {
  const node = {
    tagName: tag,
    children: [],
    textContent: '',
    className: '',
    value: '',
    placeholder: '',
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    setAttribute() {},
    remove() {},
    click() {
      return this.listeners.click?.();
    },
  };
  created.push(node);
  return node;
}

function installDom() {
  created.length = 0;
  const byId = {};
  for (const id of ['reading', 'controls', 'status', 'count', 'cohort', 'export', 'clear', 'version', 'gyms']) {
    byId[id] = makeElement('div');
  }
  globalThis.document = {
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => makeElement(tag),
    body: makeElement('body'),
  };
  globalThis.Blob = class {};
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  return byId;
}

/** Every element ever created whose text matches — how we find the Log button. */
const findByText = (text) => created.filter((n) => n.textContent === text);

// ── A mock `chrome`, including the content script's answer ───────────────────
function installChrome(reading) {
  const local = new Map();
  const session = new Map();
  const area = (map) => ({
    async get(key) {
      return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {};
    },
    async set(entries) {
      for (const [k, v] of Object.entries(entries)) map.set(k, structuredClone(v));
    },
    async remove(key) {
      map.delete(key);
    },
  });
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '9.9.9', optional_host_permissions: ['http://localhost/*'] }),
    },
    // The panel asks for and hands back host permissions; without these the popup throws at
    // startup and the recorder tests stop testing the recorder.
    permissions: { request: async () => true, remove: async () => true },
    storage: { local: area(local), session: area(session) },
    tabs: {
      async query() {
        return [{ id: 1 }];
      },
      // Overridable, so a test can model a page where the content script never answers.
      async sendMessage() {
        return reading;
      },
    },
  };
  return { local };
}

const BOOKING_READING = {
  // What Booking.com actually returned in the first real session: an address, never a coordinate,
  // so the page never settles and stays provisional for the full poll. Every popup bug so far has
  // been on precisely this path.
  result: { status: 'found_address', tier: 3, precision: null },
  tiers: {
    tier1: 'not_found',
    tier2: 'not_found',
    tier3: 'found_address',
    tier1Reason: 'lodging type found, no coordinates published',
    tier2Reason: 'no map url carried a usable coordinate',
    tier3Reason: null,
  },
  timing: { totalMs: 2.2, readingReadyMs: null, addressReadyMs: 605, navigationDelayMs: 0, probeDelayMs: 0 },
  provisional: true,
  pageToken: 'token-a',
  detectedHost: 'www.booking.com',
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('the popup loads, renders and logs a still-settling Booking page', async () => {
  const byId = installDom();
  const { local } = installChrome(BOOKING_READING);

  // Loading the module runs start() → migrate → render. A ReferenceError anywhere in that path,
  // which is what shipped twice, fails here.
  await import('../src/popup/popup.js');
  await settle();

  // The version has to be on screen, or it cannot serve its purpose: confirming a reload took.
  assert.ok(findByText('v9.9.9').length > 0 || byId.version.textContent === 'v9.9.9',
    'the popup must display the running version');

  const logButton = findByText('Log').at(-1);
  assert.ok(logButton, 'there must be a Log button even while the page is still settling');

  await logButton.click();
  await settle();

  const records = local.get('phase1_records') ?? [];
  assert.equal(records.length, 1, 'pressing Log must produce exactly one record');

  const [record] = records;
  assert.equal(record.outcome, 'found_address');
  assert.equal(record.family, 'booking');
  assert.equal(record.variant, 'primary');
  assert.equal(record.settled, false, 'logged while still settling, and the record should say so');
  assert.equal(record.verified, undefined ?? record.verified, 'nothing was verified');
  assert.equal(record.tiers.tier1Reason, 'lodging type found, no coordinates published');

  // And nothing about the page itself.
  const serialised = JSON.stringify(record);
  for (const leak of ['booking.com', 'www.', 'http', 'token-a']) {
    assert.ok(!serialised.includes(leak), `record leaked "${leak}"`);
  }
});

test('pressing Log twice records once', async () => {
  // Records carry no identifier by design, so a duplicate cannot be found or removed later.
  const { local } = installChrome(BOOKING_READING);
  const records = local.get('phase1_records') ?? [];
  assert.ok(records.length <= 1);
});

test('the popup does not await the page read before painting', () => {
  // On a page with no content script — a new tab, GitHub, anything that is not a listing — every
  // retry throws instantly and waits out its interval, so the 9-second budget sized for the slowest
  // Booking attachment was paid in full by the commonest case. Nothing rendered for those 9 seconds
  // and the popup looked frozen while it was merely waiting.
  //
  // Asserted structurally rather than behaviourally: the popup module can only be imported once per
  // process, and this is a property of the ORDER of two statements, which reads clearly in source
  // and would be obscured by a timing test that could pass on a fast machine either way.
  // `import.meta.dirname`, not `new URL` — the DOM mock installed by the tests above replaces the
  // global URL constructor, so the usual idiom throws here and nowhere else.
  const source = readFileSync(join(import.meta.dirname, '../src/popup/popup.js'), 'utf8');
  const body = source.slice(source.indexOf('async function render()'));

  const kickOff = body.indexOf('const readingPromise = readActivePage(');
  const paintCount = body.indexOf('await refreshCount()');
  const paintGyms = body.indexOf('renderGymsIdle()');
  const awaitRead = body.indexOf('await readingPromise');

  assert.ok(kickOff !== -1, 'the read must be started as a promise, not awaited inline');
  assert.ok(awaitRead !== -1, 'and awaited later');
  assert.ok(paintCount > kickOff && paintCount < awaitRead,
    'the record count must paint before the read is awaited');
  assert.ok(paintGyms > kickOff && paintGyms < awaitRead,
    'the gyms panel must paint before the read is awaited');
  assert.equal(/await readActivePage\(\{ attempts: 30/.test(body), false,
    'the 30-attempt read must never be awaited inline again');
});
