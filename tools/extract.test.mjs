import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toTransmittablePoint,
  isUsableCoordinate,
  distanceMetres,
  parseCoordinate,
} from '../src/lib/geo.js';
import { extractFromStructuredData } from '../src/extract/tier1-structured-data.js';
import { extractFromMapLinks } from '../src/extract/tier2-map-links.js';
import { extractFromAddressText } from '../src/extract/tier3-address-text.js';
import { ldJsonDocument, linkDocument, fakeDocument, textNode } from './fake-dom.mjs';

// ─── geo ──────────────────────────────────────────────────────────────────────

test('rounding reduces precision to ~1km', () => {
  assert.deepEqual(toTransmittablePoint(38.711503, -9.128744), { lat: 38.71, lon: -9.13 });
});

test('rounding is the only way a point is produced, and it refuses junk', () => {
  assert.equal(toTransmittablePoint(NaN, 0), null);
  assert.equal(toTransmittablePoint(91, 0), null);
  assert.equal(toTransmittablePoint(0, 181), null);
});

test('a rounded point is still close enough to answer the question', () => {
  const exact = { lat: 38.711503, lon: -9.128744 };
  const rounded = toTransmittablePoint(exact.lat, exact.lon);
  // The privacy design only works if ~1km of rounding does not break the product. Assert it.
  assert.ok(distanceMetres(exact, rounded) < 1000);
});

test('Null Island is refused — a blank template field must not become a location', () => {
  assert.equal(isUsableCoordinate(0, 0), false);
  assert.equal(isUsableCoordinate(0.0001, 0), true);
});

// ─── tier 1 ───────────────────────────────────────────────────────────────────

const HOTEL = JSON.stringify({
  '@type': 'Hotel',
  name: 'Example',
  geo: { latitude: 38.7115, longitude: -9.1287 },
});

test('tier 1 reads geo from a lodging type', () => {
  const r = extractFromStructuredData(ldJsonDocument(HOTEL));
  assert.equal(r.status, 'found');
  assert.equal(r.tier, 1);
  assert.equal(r.lat, 38.7115);
});

test('tier 1 finds a lodging node nested in @graph', () => {
  const graph = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'BreadcrumbList' }, JSON.parse(HOTEL)],
  });
  assert.equal(extractFromStructuredData(ldJsonDocument(graph)).status, 'found');
});

test('tier 1 accepts string coordinates — both forms are valid schema.org', () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: '38.7115', longitude: '-9.1287' } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'found');
});

test('tier 1 refuses a comma decimal rather than guessing what it means', () => {
  // "38,7115" could be a European decimal or a truncated "lat,lon" pair. Guessing wrong moves the
  // point, and a moved point is the confidently-wrong failure this project cares most about.
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: '38,7115', longitude: '-9,1287' } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'not_found');
});

test('tier 1 ignores geo on a non-lodging type', () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Organization', geo: { latitude: 51.5, longitude: -0.1 } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'not_found');
});

test('a malformed block does not stop the others being read', () => {
  const r = extractFromStructuredData(ldJsonDocument('{ not json at all', HOTEL));
  assert.equal(r.status, 'found');
});

test('a page-supplied __proto__ key cannot pollute', () => {
  const hostile = '{"@type":"Hotel","__proto__":{"polluted":true},"geo":{"latitude":1,"longitude":1}}';
  extractFromStructuredData(ldJsonDocument(hostile));
  assert.equal({}.polluted, undefined);
});

test('deeply nested page JSON terminates instead of hanging', () => {
  let nested = { '@type': 'Thing' };
  for (let i = 0; i < 5000; i += 1) nested = { child: nested };
  const started = Date.now();
  extractFromStructuredData(ldJsonDocument(JSON.stringify(nested)));
  assert.ok(Date.now() - started < 2000);
});

test('absence is reported as not_found with a reason, never as an empty success', () => {
  const r = extractFromStructuredData(fakeDocument({}));
  assert.equal(r.status, 'not_found');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

// ─── tier 2 ───────────────────────────────────────────────────────────────────

test('tier 2 reads a lat,lon query parameter', () => {
  const r = extractFromMapLinks(linkDocument('https://maps.example/?ll=38.7115,-9.1287'));
  assert.equal(r.status, 'found');
  assert.equal(r.tier, 2);
});

test('tier 2 reads split lat/lng parameters', () => {
  const r = extractFromMapLinks(linkDocument('/map?lat=38.7115&lng=-9.1287'));
  assert.equal(r.status, 'found');
});

test("tier 2 reads Google's @lat,lon path form", () => {
  const r = extractFromMapLinks(linkDocument('https://www.google.com/maps/@38.7115,-9.1287,15z'));
  assert.equal(r.status, 'found');
});

test('tier 2 refuses a blank lat with a present lng — Number(\'\') is 0 and 0 is a real latitude', () => {
  // Regression: this produced the valid-looking point 0,20 and could be selected as the listing's
  // location. isUsableCoordinate only rejects exactly 0,0, so nothing downstream caught it.
  const r = extractFromMapLinks(linkDocument('/map?lat=&lng=20'));
  assert.equal(r.status, 'not_found');
});

test('the strict coordinate parser is shared by every tier', () => {
  assert.equal(Number.isNaN(parseCoordinate('')), true);
  assert.equal(Number.isNaN(parseCoordinate('38,7115')), true);
  assert.equal(Number.isNaN(parseCoordinate(null)), true);
  assert.equal(parseCoordinate('38.7115'), 38.7115);
  assert.equal(parseCoordinate(-9.1287), -9.1287);
});

test('tier 1 source carries no page-controlled text', () => {
  // The source string used to interpolate the page's own @type, so a page could put arbitrary text
  // into a field that then reached an exported artifact.
  const hostile = JSON.stringify({
    '@type': ['<script>alert(1)</script> secret-page-data', 'Hotel'],
    geo: { latitude: 38.7115, longitude: -9.1287 },
  });
  const r = extractFromStructuredData(ldJsonDocument(hostile));
  assert.equal(r.status, 'found');
  assert.equal(r.source, 'ld+json.geo');
});

test('tier 1 does not claim precision it has not checked', () => {
  // Labelling every published point 'exact' would record a site that deliberately fuzzes location
  // as building-accurate on every listing. Precision is measured, not assumed.
  const r = extractFromStructuredData(ldJsonDocument(HOTEL));
  assert.equal(r.precision, 'unknown');
});

test('tier 1 skips an oversized block before parsing it', () => {
  const huge = `{"@type":"Hotel","pad":"${'x'.repeat(600 * 1024)}"}`;
  const r = extractFromStructuredData(ldJsonDocument(huge, HOTEL));
  // The oversized block is skipped without being parsed; the sane one after it still works.
  assert.equal(r.status, 'found');
});

test('tier 2 always reports approximate — a pin is where the site chose to draw it', () => {
  const r = extractFromMapLinks(linkDocument('https://maps.example/?ll=38.7115,-9.1287'));
  assert.equal(r.precision, 'approximate');
});

test('tier 2 ignores a non-map link that happens to contain digits', () => {
  const r = extractFromMapLinks(linkDocument('https://example.com/reviews/12345'));
  assert.equal(r.status, 'not_found');
});

test('tier 2 survives a malformed url', () => {
  const r = extractFromMapLinks(linkDocument('http://[not a url/?ll=1,2'));
  assert.equal(r.status, 'not_found');
});

// ─── tier 3 ───────────────────────────────────────────────────────────────────

test('tier 3 returns an address string, not a coordinate', () => {
  const doc = fakeDocument({ '[itemprop="address"]': [textNode('Travessa das Merceeiras 27, Lisboa')] });
  const r = extractFromAddressText(doc);
  assert.equal(r.status, 'found_address');
  assert.equal(r.lat, undefined);
});

test('tier 3 rejects a label that merely lives in an address-shaped element', () => {
  const doc = fakeDocument({ '[class*="address" i]': [textNode('Show address')] });
  assert.equal(extractFromAddressText(doc).status, 'not_found');
});

// ─── export shape ─────────────────────────────────────────────────────────────

test('the export is an allowlist — a field added later is withheld, not shipped', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  const [out] = exportableRecords([
    {
      site: 'airbnb.com',
      verdict: 'correct',
      timing: { totalMs: 12 },
      // None of these may survive. The first three are the fields the harness must never emit;
      // the last is the case an allowlist exists for — something nobody thought about yet.
      urlKey: 'deadbeef',
      url: 'https://www.airbnb.com/rooms/12345',
      note: 'the Smiths, 14 Acacia Ave',
      groundTruth: { lat: 1, lon: 2 },
      somethingAddedNextMonth: 'page text',
      result: { status: 'found', tier: 1, lat: 38.7115, lon: -9.1287, source: 'ld+json.geo' },
    },
  ]);

  assert.deepEqual(Object.keys(out).sort(), ['result', 'site', 'timing', 'verdict']);
  // A coordinate is a location. The report is computed from verdicts, so it never needs one.
  assert.equal(out.result.lat, undefined);
  assert.equal(out.result.lon, undefined);
  assert.equal(out.result.status, 'found');
});

test('an unrecognised source string cannot smuggle page text into the export', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  const long = 'x'.repeat(200);
  const [out] = exportableRecords([{ result: { status: 'found', source: long } }]);
  assert.equal(out.result.source, 'other');
});

test('the site label comes from our allowlist, never from the page', async () => {
  const { siteLabelFor } = await import('../src/lib/storage.js');
  assert.equal(siteLabelFor('www.airbnb.com'), 'airbnb.com');
  assert.equal(siteLabelFor('secure.booking.com'), 'booking.com');
  // A host we never listed cannot introduce a new label.
  assert.equal(siteLabelFor('airbnb.com.evil.example'), 'other');
});

test('nothing derived from the URL is persisted, not even a hash', async () => {
  const storage = await import('../src/lib/storage.js');
  // A 32-bit hash of a URL from a known site is walkable, so it was removed rather than kept as a
  // token gesture. If a future change reintroduces one, this fails.
  assert.equal(storage.urlKey, undefined);
  const [out] = storage.exportableRecords([{ urlKey: 'deadbeef', url: 'https://x/y', verdict: 'correct' }]);
  assert.equal(out.urlKey, undefined);
  assert.equal(out.url, undefined);
});

test('a longer site label wins, so airbnb.com.au is not read as airbnb.com', async () => {
  const { siteLabelFor, siteFamilyFor } = await import('../src/lib/storage.js');
  assert.equal(siteLabelFor('www.airbnb.com.au'), 'airbnb.com.au');
  assert.equal(siteFamilyFor('airbnb.com.au'), 'airbnb');
  assert.equal(siteFamilyFor('other'), 'other');
});

test('the export boundary re-rounds a coordinate the caller did not round', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  // A caller handing over a full-precision point must not be able to put one in the record.
  const [out] = exportableRecords([{ transmitted: { lat: 38.711503, lon: -9.128744 } }]);
  assert.deepEqual(out.transmitted, { lat: 38.71, lon: -9.13 });
});

test('the export boundary rejects an unusable point rather than passing it through', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  assert.equal(exportableRecords([{ transmitted: { lat: 0, lon: 0 } }])[0].transmitted, null);
  assert.equal(exportableRecords([{ transmitted: 'not a point' }])[0].transmitted, null);
});
