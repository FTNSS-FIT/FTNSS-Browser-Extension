// End-to-end: a listing page in, a report out.
//
// Every other test here checks one piece. This one runs the whole pipeline — extract a realistic
// page, build the reading the content script would send, build the record the popup would save,
// put it through storage, export it, and parse the export the way the report does.
//
// It exists because the two worst bugs in this repository's history were not in any single piece.
// The popup imported a function storage.js did not export, and a later patch left a reschedule
// unreachable; both left the extension silently doing nothing, and every unit test still passed
// because no test ever crossed a file boundary. The gap was between the parts, so the test has to be
// too.
//
// This covers everything except the browser shell itself: message passing, the manifest, and the DOM
// of a real site. Those need a browser, and they are what the manual protocol in
// docs/PHASE-1-MEASUREMENT.md is for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── A mock `chrome`, installed before storage.js is imported ─────────────────
//
// storage.js touches `chrome` only inside function bodies, so importing it is safe either way — but
// the calls have to land somewhere for the pipeline to run.
function installMockChrome() {
  const areas = { local: new Map(), session: new Map() };
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
    storage: { local: area(areas.local), session: area(areas.session) },
    runtime: { id: 'test-extension-id' },
  };
  return areas;
}

// ── A listing page that looks like the real thing ────────────────────────────
//
// Deliberately messier than the unit fixtures: several ld+json blocks, the lodging one nested in an
// @graph behind a breadcrumb, a map link, and address text. A page that only exercises the happy
// path proves the pipeline runs, not that it runs on anything real.
const LISTING = {
  'script[type="application/ld+json"]': [
    { textContent: JSON.stringify({ '@type': 'WebSite', name: 'Example Travel' }) },
    { textContent: '{ truncated json' },
    {
      textContent: JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'BreadcrumbList', itemListElement: [] },
          {
            '@type': ['Hotel', 'LocalBusiness'],
            name: 'Memmo Alfama',
            address: {
              '@type': 'PostalAddress',
              streetAddress: 'Travessa das Merceeiras 27',
              addressLocality: 'Lisboa',
              addressCountry: 'PT',
            },
            geo: { latitude: '38.7115', longitude: '-9.1287' },
          },
        ],
      }),
    },
  ],
  'a[href], img[src], iframe[src]': [
    { getAttribute: (n) => (n === 'href' ? '/reviews/12345' : null) },
    { getAttribute: (n) => (n === 'href' ? 'https://maps.example/?ll=38.7116,-9.1288' : null) },
  ],
  '[itemprop="address"]': [{ textContent: 'Travessa das Merceeiras 27, 1100-348 Lisboa' }],
};

const documentFrom = (map) => ({ querySelectorAll: (selector) => map[selector] ?? [] });

test('a realistic listing goes all the way through to a report row', async () => {
  installMockChrome();
  const { runExtraction } = await import('../src/extract/index.js');
  const storage = await import('../src/lib/storage.js');
  const { toTransmittablePoint, distanceMetres } = await import('../src/lib/geo.js');

  // 1. The content script extracts.
  const extraction = runExtraction(documentFrom(LISTING));
  assert.equal(extraction.result.status, 'found', 'the fixture listing should be readable');
  assert.equal(extraction.result.tier, 1, 'structured data should win over the map link');
  assert.equal(extraction.result.precision, 'unknown', 'precision is measured, never assumed');

  // 2. The person declares a cohort and records a verdict.
  await storage.setCurrentCohort('booking.com');
  await storage.setBatchCohortLabel('booking.com');

  const groundTruth = { lat: 38.7115, lon: -9.1287 };
  await storage.saveRecord({
    recordedAt: '2026-08-04',
    verdict: 'correct',
    precisionVerdict: 'building',
    timing: { totalMs: 8, readingReadyMs: 240, probeDelayMs: 0, navigationDelayMs: 0 },
    tiers: {
      tier1: extraction.tiers.tier1.status,
      tier2: extraction.tiers.tier2.status,
      tier3: extraction.tiers.tier3.status,
    },
    errorMetres: Math.round(distanceMetres(extraction.result, groundTruth)),
    result: extraction.result,
    transmitted: toTransmittablePoint(extraction.result.lat, extraction.result.lon),
  });

  // 3. It comes back out of storage already projected — not only at export time.
  const stored = await storage.loadRecords();
  assert.equal(stored.length, 1);
  const serialised = JSON.stringify(stored);
  for (const leak of ['Memmo', 'Merceeiras', 'Lisboa', 'booking', 'airbnb', 'http']) {
    assert.ok(!serialised.includes(leak), `stored record leaked "${leak}"`);
  }

  // 4. The export carries what the report needs and nothing else.
  const [exported] = storage.exportableRecords(stored);
  assert.equal(exported.verdict, 'correct');
  assert.equal(exported.result.status, 'found');
  assert.equal(exported.result.lat, undefined, 'an exact coordinate must never be exported');
  assert.deepEqual(exported.transmitted, toTransmittablePoint(38.7115, -9.1287));
  assert.ok(distanceMetres(groundTruth, exported.transmitted) < 1200, 'still answers the question');

  // 5. The report's own hit rule, applied to the exported row.
  const inBudget =
    exported.timing.readingReadyMs + (exported.timing.navigationDelayMs ?? 0) <= 800 &&
    exported.timing.totalMs <= 150;
  assert.ok(exported.verdict === 'correct' && exported.result.status === 'found' && inBudget);
});

test('an unreadable page produces a recordable miss, not silence', async () => {
  installMockChrome();
  const { runExtraction } = await import('../src/extract/index.js');
  // The population most at risk of being silently dropped, and the one every bias bug in this repo
  // has excluded. It must reach the report as a miss.
  const extraction = runExtraction(documentFrom({}));
  assert.equal(extraction.result.status, 'not_found');
  assert.ok(typeof extraction.result.reason === 'string' && extraction.result.reason.length > 0);
});

test('a self-contradicting page is ambiguous, and never resolved by a lower tier', async () => {
  installMockChrome();
  const { runExtraction } = await import('../src/extract/index.js');
  const contradictory = {
    ...LISTING,
    'a[href], img[src], iframe[src]': [
      { getAttribute: (n) => (n === 'href' ? 'https://maps.example/?ll=51.5074,-0.1278' : null) },
    ],
  };
  const extraction = runExtraction(documentFrom(contradictory));
  assert.equal(extraction.result.status, 'ambiguous');
  // And it must not have fallen through to the address text sitting right there.
  assert.notEqual(extraction.result.status, 'found_address');
});

test('switching cohort mid-batch is refused rather than silently mixing', async () => {
  installMockChrome();
  const storage = await import('../src/lib/storage.js');
  await storage.setCurrentCohort('booking.com');
  await storage.setBatchCohortLabel('booking.com');
  await storage.saveRecord({ verdict: 'correct', result: { status: 'found', tier: 1 } });

  await storage.setCurrentCohort('airbnb.com');
  await assert.rejects(
    () => storage.saveRecord({ verdict: 'correct', result: { status: 'found', tier: 1 } }),
    /export and clear/,
    'a mixed batch cannot be split afterwards, so it must not be created',
  );
});

test('legacy records on disk are sanitised by the startup migration', async () => {
  const areas = installMockChrome();
  const storage = await import('../src/lib/storage.js');
  // What an early build wrote: URL, note, address text, exact coordinates.
  areas.local.set('phase1_records', [
    {
      url: 'https://www.booking.com/hotel/pt/memmo-alfama.html',
      note: 'the Smiths, room 4',
      verdict: 'correct',
      result: { status: 'found_address', address: 'Travessa das Merceeiras 27', lat: 38.7115, lon: -9.1287 },
    },
  ]);

  await storage.migrateStoredRecords();

  const after = JSON.stringify(await storage.loadRecords());
  for (const leak of ['booking.com', 'Merceeiras', 'the Smiths', '38.7115']) {
    assert.ok(!after.includes(leak), `migration left "${leak}" on disk`);
  }
  assert.ok(after.includes('found_address'), 'the measurement itself must survive the migration');
});
