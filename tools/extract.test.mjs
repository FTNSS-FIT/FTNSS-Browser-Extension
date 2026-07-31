import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSMIT_KM,
  toTransmittablePoint,
  isUsableCoordinate,
  distanceMetres,
  parseCoordinate,
} from '../src/lib/geo.js';

import { extractFromStructuredData } from '../src/extract/tier1-structured-data.js';
import { extractFromMapLinks } from '../src/extract/tier2-map-links.js';
import { extractFromAddressText } from '../src/extract/tier3-address-text.js';
import { ldJsonDocument, linkDocument, fakeDocument, textNode, scriptNode, attrNode } from './fake-dom.mjs';

// ─── geo ──────────────────────────────────────────────────────────────────────

test('rounding reduces precision to the transmission grid', () => {
  const r = toTransmittablePoint(38.711503, -9.128744);
  assert.ok(distanceMetres({ lat: 38.711503, lon: -9.128744 }, r) < TRANSMIT_KM * 1000);
});

test('the rounding guarantee holds at HIGH LATITUDES, not just near the equator', () => {
  // A fixed 2dp longitude is ~1.1km at the equator but ~380m at 70 degrees and ~190m at 80 — so a
  // uniform-sounding promise was weakest in exactly the Nordic markets this extension lists.
  for (const lat of [0, 38.71, 51.5, 60, 69.65, 80, 85]) {
    let worst = 0;
    for (let i = 0; i < 200; i += 1) {
      const point = { lat: lat + (i % 10) * 0.001, lon: 10 + i * 0.0009 };
      const rounded = toTransmittablePoint(point.lat, point.lon);
      worst = Math.max(worst, distanceMetres(point, rounded));
    }
    // Coarse enough to be a real guarantee everywhere...
    // Bounds DERIVED from the constant, not hardcoded: changing TRANSMIT_KM must not silently
    // invalidate the test that guards it. A cell's worst-case error is about 0.7x its size.
    assert.ok(worst > TRANSMIT_KM * 300, `rounding at ${lat} is too fine: ${Math.round(worst)}m`);
    assert.ok(worst < TRANSMIT_KM * 1000, `rounding at ${lat} is too coarse: ${Math.round(worst)}m`);
  }
});

test('the rounding grid is recomputable from the published point alone', () => {
  // Someone checking our claim has only the output. Rounding an already-rounded point must be a
  // no-op, or the grid they can derive is not the grid we used.
  const once = toTransmittablePoint(69.6492, 18.9553);
  const twice = toTransmittablePoint(once.lat, once.lon);
  assert.deepEqual(twice, once);
});

test('rounding is the only way a point is produced, and it refuses junk', () => {
  assert.equal(toTransmittablePoint(NaN, 0), null);
  assert.equal(toTransmittablePoint(91, 0), null);
  assert.equal(toTransmittablePoint(0, 181), null);
});

test('a rounded point is still close enough to answer the question', () => {
  const exact = { lat: 38.711503, lon: -9.128744 };
  const rounded = toTransmittablePoint(exact.lat, exact.lon);
  // The privacy design only works if the rounding does not break the product. Assert it.
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
  // Built as a STRING rather than via JSON.stringify on a 5000-deep object. stringify is recursive,
  // so how deep it can go depends on the runtime's stack — it handles this fine on the Node we run,
  // but a fixture whose validity varies by platform is a test that fails for a reason unrelated to
  // what it is testing. JSON.parse is iterative and takes it either way.
  const depth = 5000;
  const nested = '{"child":'.repeat(depth) + '{"@type":"Thing"}' + '}'.repeat(depth);
  const started = Date.now();
  extractFromStructuredData(ldJsonDocument(nested));
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
  const doc = fakeDocument({ '[itemprop="address"]': [textNode('12 Example Street, Exampleton')] });
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
      outcome: 'found',
      verified: 'correct',
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

  assert.deepEqual(Object.keys(out).sort(), ['outcome', 'result', 'timing', 'verified']);
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

test('the harness records family and variant, and never a hostname', async () => {
  const { exportableRecords, cohortRecordFor } = await import('../src/lib/storage.js');
  // DECISIONS 11: the harness labels its own operator's browsing, which the product never will. What
  // it must still never carry is a hostname — `airbnb` is a cohort, `airbnb.jp` is a location.
  const [out] = exportableRecords([
    { outcome: 'found', ...cohortRecordFor('airbnb.jp'), site: 'airbnb.jp', detectedSite: 'airbnb.jp' },
  ]);
  assert.equal(out.family, 'airbnb');
  assert.equal(out.variant, 'cctld');
  const serialised = JSON.stringify(out);
  for (const leak of ['.jp', '.com', '.co.uk', 'http']) {
    assert.ok(!serialised.includes(leak), `exported record leaked "${leak}"`);
  }
});

test('the ccTLD question is answerable without naming the country', async () => {
  const { cohortRecordFor } = await import('../src/lib/storage.js');
  assert.deepEqual(cohortRecordFor('airbnb.com'), { family: 'airbnb', variant: 'primary', brand: 'airbnb' });
  assert.deepEqual(cohortRecordFor('airbnb.co.uk'), { family: 'airbnb', variant: 'cctld', brand: 'airbnb' });
  assert.deepEqual(cohortRecordFor('booking.de'), { family: 'booking', variant: 'cctld', brand: 'booking' });
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
  const [out] = storage.exportableRecords([{ urlKey: 'deadbeef', url: 'https://x/y', outcome: 'found' }]);
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
  assert.deepEqual(out.transmitted, toTransmittablePoint(38.711503, -9.128744));
  // And it is genuinely coarser than what went in.
  assert.ok(distanceMetres({ lat: 38.711503, lon: -9.128744 }, out.transmitted) > 0);
});

test('the export boundary rejects an unusable point rather than passing it through', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  assert.equal(exportableRecords([{ transmitted: { lat: 0, lon: 0 } }])[0].transmitted, null);
  assert.equal(exportableRecords([{ transmitted: 'not a point' }])[0].transmitted, null);
});

test('rounding never produces an out-of-range point at the edges of the world', () => {
  // 179.999 rounded UP is 180.001, which is not a longitude. The storage boundary then rejected the
  // point and stored null, so a listing in Fiji or eastern Russia silently lost its coordinate and
  // the loss looked like an extraction failure rather than an arithmetic one.
  for (const [lat, lon] of [
    [0, 179.999], [0, -179.999], [0, 180], [45, 179.997],
    [89.999, 10], [-89.999, 10], [90, -180], [-90, 180],
  ]) {
    const rounded = toTransmittablePoint(lat, lon);
    assert.ok(rounded !== null, `refused a valid input: ${lat},${lon}`);
    assert.ok(
      isUsableCoordinate(rounded.lat, rounded.lon),
      `produced an out-of-range point for ${lat},${lon}: ${JSON.stringify(rounded)}`,
    );
  }
});

test('longitude wraps across the antimeridian rather than clamping', async () => {
  const { isInRange } = await import('../src/lib/geo.js');
  // Tests the PROPERTY, not one input. Which longitude rounds past 180 depends on the cell size, so
  // hardcoding an example ties the test to a particular TRANSMIT_KM — it passed at 500m and failed
  // at 250m for a reason that had nothing to do with the behaviour being checked.
  //
  // Clamping 180.001 to 180 would be wrong by a whole cell; wrapping puts it where it belongs.
  let wrapped = 0;
  for (let i = 0; i < 200; i += 1) {
    const lon = 180 - i * 0.0005;
    const rounded = toTransmittablePoint(0, lon);
    assert.ok(rounded && isInRange(rounded.lat, rounded.lon), `out of range at ${lon}`);
    assert.ok(distanceMetres({ lat: 0, lon }, rounded) < TRANSMIT_KM * 1000);
    if (rounded.lon < 0) wrapped += 1;
  }
  assert.ok(wrapped > 0, 'at least one longitude near 180 must wrap to the western hemisphere');
});

test('tier 2 fails closed when map urls disagree about where the listing is', () => {
  // Taking the first map-shaped URL assumed the listing's own map comes first. A city-overview map,
  // a "hotels near here" widget or an advert can come earlier — and a confident wrong coordinate is
  // worse than an honest failure, because it pins a gym next to a hotel nobody is looking at.
  const doc = linkDocument(
    'https://maps.example/?ll=38.7115,-9.1287',
    'https://maps.example/?ll=51.5074,-0.1278',
  );
  const r = extractFromMapLinks(doc);
  // AMBIGUOUS, not not_found. Absence means "look elsewhere", so reporting a conflict as absence let
  // the runner fall through and answer from a lower tier using one of the disputed coordinates.
  assert.equal(r.status, 'ambiguous');
  assert.match(r.reason, /disagree/);
});

test('tier 2 still answers when several map urls agree', () => {
  const doc = linkDocument(
    'https://maps.example/?ll=38.7115,-9.1287',
    'https://maps.example/?ll=38.7118,-9.1290',
  );
  assert.equal(extractFromMapLinks(doc).status, 'found');
});

test('a partial or out-of-range ground truth is refused, not coerced', async () => {
  // Number() turned "38.7115," into (38.7115, 0) — Null Island, silently — and accepted "91,0".
  // Both would have entered the positional-error statistics as though they were real readings.
  const { parseCoordinate } = await import('../src/lib/geo.js');
  const { isUsableCoordinate } = await import('../src/lib/geo.js');
  const parse = (raw) => {
    const parts = raw.split(',');
    if (parts.length !== 2) return null;
    const lat = parseCoordinate(parts[0].trim());
    const lon = parseCoordinate(parts[1].trim());
    return isUsableCoordinate(lat, lon) ? { lat, lon } : null;
  };
  for (const bad of ['38.7115,', '38.7115', '91,0', '0,181', 'abc,def', '38.7115,-9.12,3', '']) {
    assert.equal(parse(bad), null, `should have refused: "${bad}"`);
  }
  assert.deepEqual(parse('38.7115, -9.1287'), { lat: 38.7115, lon: -9.1287 });
});

test('the rounding guarantee holds at POLAR latitudes too', async () => {
  const { isInRange } = await import('../src/lib/geo.js');
  // A `Math.min(1, step)` cap here made cells 194m at 89.9 and 19m at 89.99 — the guarantee failing
  // hardest exactly where the latitude correction was supposed to be working hardest. Near the pole
  // you need a LARGER step in degrees, because the degrees themselves are short.
  for (const lat of [80, 85, 89, 89.43, 89.9, 89.99]) {
    let worst = 0;
    for (let i = 0; i < 300; i += 1) {
      const point = { lat, lon: -180 + i * 1.2 };
      const rounded = toTransmittablePoint(point.lat, point.lon);
      assert.ok(rounded && isInRange(rounded.lat, rounded.lon), `out of range at ${lat}`);
      worst = Math.max(worst, distanceMetres(point, rounded));
    }
    assert.ok(worst > TRANSMIT_KM * 300, `rounding at ${lat} is too fine: ${Math.round(worst)}m`);
    assert.ok(worst < TRANSMIT_KM * 1000, `rounding at ${lat} is too coarse: ${Math.round(worst)}m`);
  }
});

test('a point that legitimately rounds onto Null Island is kept, while (0,0) input is refused', () => {
  // These are different questions. Re-applying the broken-template heuristic as a postcondition
  // discarded every correctly-rounded point within half a cell of the equator or prime meridian.
  assert.deepEqual(toTransmittablePoint(0.001, 0.001), { lat: 0, lon: 0 });
  assert.equal(toTransmittablePoint(0, 0), null);
});

test('saving migrates existing records through the projection', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  // Legacy rows were rewritten to disk untouched on every save, so a URL stored by an earlier build
  // outlived the change that stopped storing them.
  const legacy = { url: 'https://www.airbnb.com/rooms/1', note: 'the Smiths', outcome: 'found' };
  const [migrated] = exportableRecords([legacy]);
  assert.equal(migrated.url, undefined);
  assert.equal(migrated.note, undefined);
  assert.equal(migrated.outcome, 'found');
});

test('tier 1 fails closed when structured data describes two different places', () => {
  // A "similar properties" block or a parent chain entry can put a second lodging object on the
  // page, and the first in document order need not be the listing on screen.
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: 51.5074, longitude: -0.1278 } }),
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7115, longitude: -9.1287 } }),
  );
  const r = extractFromStructuredData(doc);
  assert.equal(r.status, 'ambiguous');
  assert.match(r.reason, /two different places/);
});

test('tier 1 still answers when several lodging objects agree', () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7115, longitude: -9.1287 } }),
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7118, longitude: -9.129 } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'found');
});

test('a generic schema.org Place is not treated as the listing', () => {
  // Place is the base type for anything with a location — a landmark, a restaurant, an airport.
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Place', name: 'Nearby landmark', geo: { latitude: 1, longitude: 1 } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'not_found');
});

test('the agreement tolerance is tighter than the correctness bound', () => {
  // A disagreement threshold looser than the ~1.11km within which a read counts as correct does not
  // catch wrong answers, it certifies them: two points could "agree" while being far enough apart
  // that at most one of them could ever have been right.
  const apart = extractFromMapLinks(
    linkDocument('https://maps.example/?ll=38.7115,-9.1287', 'https://maps.example/?ll=38.7250,-9.1287'),
  );
  assert.equal(apart.status, 'ambiguous', '1.5km apart must not count as agreement');

  const together = extractFromMapLinks(
    linkDocument('https://maps.example/?ll=38.7115,-9.1287', 'https://maps.example/?ll=38.7116,-9.1288'),
  );
  assert.equal(together.status, 'found', 'the same building must still resolve');
});

test('tier 1 applies the same tolerance as tier 2', () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7115, longitude: -9.1287 } }),
    JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.725, longitude: -9.1287 } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'ambiguous');
});

test('rounding is idempotent everywhere, including across the antimeridian', async () => {
  const { isInRange } = await import('../src/lib/geo.js');
  // Longitude is circular; a step that does not divide 360 leaves cell boundaries misaligned at the
  // antimeridian. Because the storage boundary deliberately re-rounds, that second pass moved stored
  // points by up to a full cell — (49.97, -179.997) landed 1136m from its input, outside the
  // guarantee. Re-rounding must be a no-op, or the grid an outside reader derives is not ours.
  let worstDrift = 0;
  for (const lat of [0, 38.71, 49.97, 51.5, 60, 69.65, 80, 89, 89.9]) {
    for (let i = 0; i < 360; i += 1) {
      const point = { lat, lon: -180 + i * 1.0003 };
      const once = toTransmittablePoint(point.lat, point.lon);
      assert.ok(once && isInRange(once.lat, once.lon));
      const twice = toTransmittablePoint(once.lat, once.lon);
      assert.deepEqual(twice, once, `not idempotent at ${lat},${point.lon}`);
      worstDrift = Math.max(worstDrift, distanceMetres(point, once));
    }
  }
  assert.ok(worstDrift < TRANSMIT_KM * 1000, `rounding error too large: ${Math.round(worstDrift)}m`);
});

test('the reported antimeridian case stays inside the guarantee', () => {
  const input = { lat: 49.97, lon: -179.997 };
  const once = toTransmittablePoint(input.lat, input.lon);
  const twice = toTransmittablePoint(once.lat, once.lon);
  assert.deepEqual(twice, once);
  assert.ok(distanceMetres(input, twice) < TRANSMIT_KM * 1000);
});

// ─── cross-tier agreement ─────────────────────────────────────────────────────

test('the read fails when structured data and the map link disagree with each other', async () => {
  const { runExtraction } = await import('../src/extract/index.js');
  // Checking conflicts only WITHIN a tier missed the page contradicting itself ACROSS sources — at
  // least as strong a signal that we cannot tell, and previously answered confidently from tier 1.
  const doc = fakeDocument({
    'script[type="application/ld+json"]': [
      scriptNode(JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7115, longitude: -9.1287 } })),
    ],
    'a[href], img[src], iframe[src]': [attrNode({ href: 'https://maps.example/?ll=51.5074,-0.1278' })],
  });
  assert.equal(runExtraction(doc).result.status, 'ambiguous');
});

test('the read succeeds when the tiers agree', async () => {
  const { runExtraction } = await import('../src/extract/index.js');
  const doc = fakeDocument({
    'script[type="application/ld+json"]': [
      scriptNode(JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7115, longitude: -9.1287 } })),
    ],
    'a[href], img[src], iframe[src]': [attrNode({ href: 'https://maps.example/?ll=38.7116,-9.1288' })],
  });
  const r = runExtraction(doc).result;
  assert.equal(r.status, 'found');
  assert.equal(r.tier, 1);
});

test('an ambiguous tier is never rescued by a lower tier', async () => {
  const { runExtraction } = await import('../src/extract/index.js');
  const doc = fakeDocument({
    'script[type="application/ld+json"]': [
      scriptNode(JSON.stringify({ '@type': 'Hotel', geo: { latitude: 38.7115, longitude: -9.1287 } })),
      scriptNode(JSON.stringify({ '@type': 'Hotel', geo: { latitude: 51.5074, longitude: -0.1278 } })),
    ],
    '[itemprop="address"]': [textNode('12 Example Street, Exampleton')],
  });
  assert.equal(runExtraction(doc).result.status, 'ambiguous');
});

test('the export allowlist is exact values, not "short enough"', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  // A length check is not an allowlist: it accepted any string under 41 characters, so a legacy
  // record carrying an old interpolated @type — attacker-controlled page text — exported verbatim.
  const [out] = exportableRecords([
    { result: { status: 'found', tier: 1, source: 'ld+json <script>evil</script>.geo' } },
  ]);
  assert.equal(out.result.source, 'other');
});

test('nested objects are rebuilt, not carried over', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  // Copying `timing` and `tiers` wholesale meant the allowlist stopped at the top level.
  const [out] = exportableRecords([
    {
      timing: { totalMs: 12, smuggled: 'page text', readingReadyMs: -5 },
      tiers: { tier1: 'found', tier2: 'evil', smuggled: 'page text' },
    },
  ]);
  assert.equal(out.timing.smuggled, undefined);
  assert.equal(out.timing.readingReadyMs, null, 'a negative duration is not a duration');
  assert.equal(out.tiers.smuggled, undefined);
  assert.equal(out.tiers.tier2, 'not_found', 'an unknown tier status falls back, it does not pass');
});

test('tier 3 bounds how much work a page can commission', () => {
  // textContent materialises the whole subtree before any cap applies, and readiness probes re-run
  // extraction every 250ms — so an unbounded read is work a page can ask for repeatedly.
  const huge = 'x '.repeat(500_000) + '12 Example Street';
  const many = Array.from({ length: 5000 }, () => textNode(huge));
  const doc = fakeDocument({ '[class*="address" i]': many });
  const started = Date.now();
  extractFromAddressText(doc);
  assert.ok(Date.now() - started < 2000, 'tier 3 took too long on a hostile page');
});

test('coordinates published directly on the Place are found, not only under geo', () => {
  // schema.org allows both. Looking only under `geo` made a listing that uses the other standard
  // form read as having no coordinates — indistinguishable in the data from a site that genuinely
  // withholds them, which is the difference between "a market we cannot serve" and "a bug in our
  // reader".
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', latitude: 38.7115, longitude: -9.1287 }),
  );
  const r = extractFromStructuredData(doc);
  assert.equal(r.status, 'found');
  assert.equal(r.lat, 38.7115);
});

test('"no coordinates published" and "coordinates refused" are different findings', () => {
  // The first is a fact about the site; the second is a fact about us. Collapsing them into one
  // reason means the report cannot tell a market problem from a bug.
  const absent = extractFromStructuredData(
    ldJsonDocument(JSON.stringify({ '@type': 'Hotel', name: 'No geo here' })),
  );
  assert.equal(absent.reason, 'lodging type found, no coordinates published');

  const refused = extractFromStructuredData(
    // A comma decimal: indistinguishable from a truncated "lat,lon" pair, so we refuse it rather
    // than guess — but we must say that is what happened.
    ldJsonDocument(JSON.stringify({ '@type': 'Hotel', geo: { latitude: '38,7115', longitude: '-9,1287' } })),
  );
  assert.equal(refused.reason, 'lodging type found, coordinates present but refused');
});

test('an array of GeoCoordinates is read', () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', geo: [{ latitude: 38.7115, longitude: -9.1287 }] }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'found');
});

// ─── coordinates outside JSON-LD and map URLs ────────────────────────────────

test('coordinates in a geo.position meta tag are found', () => {
  // A site that renders its map client-side has the point in the document somewhere — the map
  // cannot draw without it. We were checking two places and calling the third "no coordinates".
  const doc = fakeDocument({
    'meta[name="geo.position" i]': [attrNode({ content: '38.7115;-9.1287' })],
  });
  const r = extractFromMapLinks(doc);
  assert.equal(r.status, 'found');
  assert.equal(r.source, 'meta geo');
});

test('coordinates split across og:latitude and og:longitude are found', () => {
  const doc = fakeDocument({
    'meta[property="og:latitude" i]': [attrNode({ content: '38.7115' })],
    'meta[property="og:longitude" i]': [attrNode({ content: '-9.1287' })],
  });
  assert.equal(extractFromMapLinks(doc).status, 'found');
});

test('coordinates in data attributes on a MAP container are found', () => {
  const doc = fakeDocument({
    '[class*="map" i][data-lat][data-lng]': [attrNode({ 'data-lat': '38.7115', 'data-lng': '-9.1287' })],
  });
  const r = extractFromMapLinks(doc);
  assert.equal(r.status, 'found');
  assert.equal(r.source, 'data attribute');
});

test('coordinates on an element that is NOT a map are ignored', () => {
  // A weather widget, an analytics tag or a nearby-attractions strip can carry data-lat/data-lng.
  // On a site where no other tier produces a coordinate there would be nothing to contradict it, so
  // an unassociated pair must not become the listing's position.
  const doc = fakeDocument({
    '[data-lat][data-lng]': [attrNode({ 'data-lat': '51.5074', 'data-lng': '-0.1278' })],
  });
  assert.equal(extractFromMapLinks(doc).status, 'not_found');
});

test('a meta tag that disagrees with the map pin is ambiguous, not a coin toss', () => {
  const doc = fakeDocument({
    'a[href], img[src], iframe[src]': [attrNode({ href: 'https://maps.example/?ll=38.7115,-9.1287' })],
    'meta[name="geo.position" i]': [attrNode({ content: '51.5074;-0.1278' })],
  });
  assert.equal(extractFromMapLinks(doc).status, 'ambiguous');
});

test('a blank or malformed metadata coordinate is refused, not coerced', () => {
  for (const content of ['', ';', '38.7115;', 'abc;def', '91;0']) {
    const doc = fakeDocument({ 'meta[name="geo.position" i]': [attrNode({ content })] });
    assert.equal(extractFromMapLinks(doc).status, 'not_found', `should have refused "${content}"`);
  }
});

// ─── structured address components ───────────────────────────────────────────

test('address components are captured from a lodging node with no coordinates', () => {
  // The case that matters: Booking publishes a Hotel with an address and no point, so this is
  // exactly the page that would need geocoding — and the only page where knowing which components
  // exist decides whether geocoding can be done safely.
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      name: 'Riu Plaza',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '12 Example Street',
        addressLocality: 'Exampleton',
        postalCode: 'EX1 2AB',
        addressCountry: 'GB',
      },
    }),
  );
  const r = extractFromStructuredData(doc);
  // `found_address`, not `not_found`. This assertion said not_found until 31 July 2026 and was
  // pinning the bug in place: a complete address is an ANSWER, and the reason the coordinate is
  // missing is carried alongside rather than instead of it.
  assert.equal(r.status, 'found_address');
  assert.equal(r.reason, 'lodging type found, no coordinates published');
  assert.deepEqual(r.addressComponents, {
    street: true,
    locality: true,
    region: false,
    postalCode: true,
    countryPublished: true,
    countryParsed: true,
    country: 'GB',
  });
  // The exported record keeps only presence — see storage.js.
});

test('components report PRESENCE, never the address itself', () => {
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      address: { streetAddress: '12 Example Street', addressLocality: 'Exampleton', addressCountry: 'GB' },
    }),
  );
  const serialised = JSON.stringify(extractFromStructuredData(doc).addressComponents);
  // A measurement that requires the thing whose safety it is measuring is not worth taking.
  for (const leak of ['Example Street', 'Exampleton', '12']) {
    assert.ok(!serialised.includes(leak), `components leaked "${leak}"`);
  }
  assert.ok(serialised.includes('GB'), 'the country is carried deliberately — see the module comment');
});

test('coarse geocodability needs a postcode AND a country', async () => {
  const { coarselyGeocodable } = await import('../src/extract/address-components.js');
  assert.equal(coarselyGeocodable({ postalCode: true, country: 'GB' }), true);
  // A postcode with no country is ambiguous worldwide; a country with no postcode is a nation.
  assert.equal(coarselyGeocodable({ postalCode: true, country: null }), false);
  assert.equal(coarselyGeocodable({ postalCode: false, country: 'GB' }), false);
  assert.equal(coarselyGeocodable(null), false);
});

test('a nested Country object still yields a country code', async () => {
  const { addressComponentsOf } = await import('../src/extract/address-components.js');
  const components = addressComponentsOf({
    address: { postalCode: 'M5V 2T6', addressCountry: { '@type': 'Country', name: 'ca' } },
  });
  assert.equal(components.country, 'CA');
});

test('a country name is resolved through a fixed table, and nothing else passes', async () => {
  const { addressComponentsOf } = await import('../src/extract/address-components.js');
  const code = (country) => addressComponentsOf({ address: { postalCode: 'X', addressCountry: country } }).country;

  // Booking publishes names on most pages. Reading only codes discarded a component that was there.
  assert.equal(code('Portugal'), 'PT');
  assert.equal(code('United States'), 'US');
  // The whole table, not one entry. A careless bulk replace mapped Portugal to GB and a test that
  // checked only one country locked the wrong answer in — so this checks every mapping it relies on.
  for (const [name, want] of Object.entries({
    Portugal: 'PT', Spain: 'ES', France: 'FR', Germany: 'DE', Italy: 'IT', Ireland: 'IE',
    Canada: 'CA', Mexico: 'MX', Brazil: 'BR', Netherlands: 'NL', Australia: 'AU', Japan: 'JP',
    Greece: 'GR', Norway: 'NO', Sweden: 'SE', 'New Zealand': 'NZ',
  })) {
    assert.equal(code(name), want, `${name} should map to ${want}`);
  }
  assert.equal(code('united kingdom'), 'GB');
  assert.equal(code('España'), 'ES');

  // The input is page-controlled text, so the table is the whole allowance: an unknown name yields
  // null and is reported as unparsed, never carried through as an arbitrary string.
  assert.equal(code('Freedonia'), null);
  assert.equal(code('<script>alert(1)</script>'), null);
});

test('"UK" is normalised to GB rather than passed to a geocoder as-is', async () => {
  const { addressComponentsOf } = await import('../src/extract/address-components.js');
  // Measured on real Booking pages. The UK's actual code is GB; "UK" is a reserved exception that
  // everyone uses anyway, and it would be a lookup that quietly fails.
  assert.equal(addressComponentsOf({ address: { postalCode: 'W1', addressCountry: 'UK' } }).country, 'GB');
});

test('a country published in a form we cannot parse is distinguished from one that is absent', async () => {
  const { addressComponentsOf } = await import('../src/extract/address-components.js');
  // Opposite findings: one is about the site, the other is about us. The first Booking measurements
  // came back null on 24 of 27 pages with no way to tell which had happened.
  const unparsed = addressComponentsOf({ address: { postalCode: 'M5V', addressCountry: 'Ruritania' } });
  assert.equal(unparsed.countryPublished, true, 'they published something');
  assert.equal(unparsed.country, null, 'we could not turn it into a code');

  const absent = addressComponentsOf({ address: { postalCode: 'M5V', addressLocality: 'Toronto' } });
  assert.equal(absent.countryPublished, false);
  assert.equal(absent.country, null);
});

test('the exported record carries no country code, only whether one was published', async () => {
  const { exportableRecords } = await import('../src/lib/storage.js');
  // The code answered its question — coarse geocoding is viable, and its worth varies by market
  // (DECISIONS 13). Keeping it now would introduce location onto records that carry none.
  const [out] = exportableRecords([
    { addressComponents: { street: true, locality: true, region: false, postalCode: true, countryPublished: true, country: 'GB' } },
  ]);
  assert.equal(out.addressComponents.countryPublished, true);
  assert.equal(out.addressComponents.country, undefined);
  assert.ok(!JSON.stringify(out).includes('GB'));
});

test('a country we cannot read does not count as usable', async () => {
  const { addressComponentsOf } = await import('../src/extract/address-components.js');
  // Three states, not two. Collapsing "published but unreadable" into "published" overstated
  // geocoding viability — a country we cannot turn into a code is no more use to a geocoder than
  // one that was never there, but it looked identical in the report.
  const unreadable = addressComponentsOf({ address: { postalCode: 'X', addressCountry: 'Ruritania' } });
  assert.equal(unreadable.countryPublished, true);
  assert.equal(unreadable.countryParsed, false);

  const usable = addressComponentsOf({ address: { postalCode: 'X', addressCountry: 'Canada' } });
  assert.equal(usable.countryParsed, true);

  const absent = addressComponentsOf({ address: { postalCode: 'X' } });
  assert.equal(absent.countryPublished, false);
  assert.equal(absent.countryParsed, false);
});

test('a complete "related hotel" alongside a different listing is refused, not merged', () => {
  // This test used to assert the INTERSECTION of the two — street true, postcode false — which was
  // the right answer while components were only ever a viability statistic. Once an address became
  // an answer the page could be read from, understating was no longer enough: a merge of two
  // different places describes neither, so the page is now refused outright. (Codex, PR #10.)
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      address: { streetAddress: 'A', addressLocality: 'B', postalCode: 'C', addressCountry: 'GB' },
    }),
    JSON.stringify({ '@type': 'Hotel', address: { streetAddress: 'D', addressLocality: 'E' } }),
  );
  const r = extractFromStructuredData(doc);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.addressComponents, null);
});

test('components are still intersected when the nodes agree on the place', () => {
  // The conflict check keys on street, locality, postcode and country; two blocks describing the
  // SAME listing at different levels of detail are not a conflict, and the answer must reflect the
  // less complete one rather than the more flattering.
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      address: { streetAddress: 'A', addressLocality: 'B', addressRegion: 'R', postalCode: 'C', addressCountry: 'GB' },
    }),
    JSON.stringify({
      '@type': 'Hotel',
      address: { streetAddress: 'A', addressLocality: 'B', postalCode: 'C', addressCountry: 'GB' },
    }),
  );
  const components = extractFromStructuredData(doc).addressComponents;
  assert.equal(components.street, true);
  assert.equal(components.region, false, 'only one carried a region — the answer must not overstate');
});

test('two lodging nodes in different countries are refused', async () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', address: { postalCode: 'A', addressCountry: 'GB' } }),
    JSON.stringify({ '@type': 'Hotel', address: { postalCode: 'B', addressCountry: 'FR' } }),
  );
  // We do not know which listing the page is about, and a geocoder aimed at the wrong country
  // returns nothing or somewhere wrong.
  assert.equal(extractFromStructuredData(doc).status, 'ambiguous');
});

test('Expedia Group brands are one family but keep their own labels', async () => {
  const { siteLabelFor, cohortRecordFor } = await import('../src/lib/storage.js');
  const cohort = (host) => cohortRecordFor(siteLabelFor(host));

  // Expedia, Hotels.com and Vrbo share an owner and probably a template. Grouping them answers
  // "is Booking or Airbnb the typical shape?"; keeping separate labels means we can still see if
  // one brand behaves differently from its siblings.
  // The BRAND is recorded, not just the family — otherwise every Expedia Group page persists
  // identically and a divergent sibling is invisible, which is the whole reason they were added.
  assert.deepEqual(cohort('www.expedia.com'), { family: 'expedia', variant: 'primary', brand: 'expedia' });
  assert.deepEqual(cohort('uk.hotels.com'), { family: 'expedia', variant: 'primary', brand: 'hotels' });
  assert.deepEqual(cohort('www.vrbo.com'), { family: 'expedia', variant: 'primary', brand: 'vrbo' });

  // Brand and variant answer different questions: does a sibling BRAND behave differently, and does
  // a COUNTRY variant.
  assert.deepEqual(cohort('www.expedia.de'), { family: 'expedia', variant: 'cctld', brand: 'expedia' });

  // A country variant, which is a different question from a sibling brand — calling Hotels.com a
  // ccTLD would answer the ccTLD question with the wrong data.
  assert.deepEqual(cohort('www.expedia.co.uk'), { family: 'expedia', variant: 'cctld', brand: 'expedia' });

  // And the others still work.
  assert.deepEqual(cohort('www.booking.com'), { family: 'booking', variant: 'primary', brand: 'booking' });
  assert.deepEqual(cohort('www.airbnb.com'), { family: 'airbnb', variant: 'primary', brand: 'airbnb' });
});

test('an unlisted host has no family and no variant', async () => {
  const { siteLabelFor, cohortRecordFor } = await import('../src/lib/storage.js');
  // A host we never listed cannot introduce a label, and recording 'other/cctld' would put a
  // meaningless row in the data.
  assert.deepEqual(cohortRecordFor(siteLabelFor('expedia.com.evil.example')), {
    family: 'other',
    variant: null,
    brand: null,
  });
});

test('sibling brands keep their family across country domains', async () => {
  const { siteLabelFor, cohortRecordFor } = await import('../src/lib/storage.js');
  const cohort = (host) => cohortRecordFor(siteLabelFor(host));

  // Matching only `.com` dropped every sibling ccTLD into 'other', where it cannot be recorded at
  // all — the manifest would have added the hosts and then discarded their readings, which looks
  // exactly like a market with no listings.
  assert.deepEqual(cohort('www.hotels.co.uk'), { family: 'expedia', variant: 'cctld', brand: 'hotels' });
  assert.deepEqual(cohort('www.vrbo.de'), { family: 'expedia', variant: 'cctld', brand: 'vrbo' });

  // And variant is judged against the BRAND's primary: hotels.co.uk is a country variant of
  // Hotels.com, not of Expedia.com.
  assert.deepEqual(cohort('www.hotels.com'), { family: 'expedia', variant: 'primary', brand: 'hotels' });
  assert.deepEqual(cohort('www.vrbo.com'), { family: 'expedia', variant: 'primary', brand: 'vrbo' });
});

// ---------------------------------------------------------------------------------------------
// A STRUCTURED ADDRESS WITHOUT COORDINATES IS A FINDING, NOT A FAILURE.
//
// Measured 31 July 2026: 6 of 6 Expedia and Hotels.com pages carried a complete PostalAddress in
// JSON-LD — street, locality, region, postcode and country all present — and every one was recorded
// `not_found`, because `found_address` was hardcoded to tier 3 and Expedia does not expose its
// address to tier 3's text scraper. The evidence was in the record the whole time: addressComponents
// all true, outcome not_found. Read at face value it says Expedia publishes nothing, which is the
// opposite of what it published.
// ---------------------------------------------------------------------------------------------

const EXPEDIA_SHAPED = JSON.stringify({
  '@type': 'Hotel',
  address: {
    '@type': 'PostalAddress',
    streetAddress: '1 Example Street',
    addressLocality: 'Exampleton',
    addressRegion: 'EX',
    postalCode: 'EX1 2AB',
    addressCountry: 'United Kingdom',
  },
});

test('tier 1 reports a structured address when the page publishes no coordinates', () => {
  const r = extractFromStructuredData(ldJsonDocument(EXPEDIA_SHAPED));
  assert.equal(r.status, 'found_address');
  assert.equal(r.tier, 1);
  // The finding about the SITE survives the rescue: we still know why there was no coordinate.
  assert.equal(r.reason, 'lodging type found, no coordinates published');
  // Presence, never values. A street address IS the listing identity.
  assert.equal(r.address, null);
  assert.equal(r.addressComponents.postalCode, true);
});

test('a page with an address and no coordinates is not recorded as unreadable', async () => {
  const { runExtraction } = await import('../src/extract/index.js');
  const doc = ldJsonDocument(EXPEDIA_SHAPED);
  const { result, tiers } = runExtraction(doc);
  assert.equal(result.status, 'found_address');
  assert.equal(result.tier, 1);
  // Tier 3 genuinely could not read it — that stays true and stays recorded.
  assert.equal(tiers.tier3.status, 'not_found');
});

test('an address fragment is not promoted to a place', () => {
  // A country alone, or a street alone, resolves to nothing. Reporting found_address off either
  // would trade a false negative for a false positive, which is not an improvement.
  const fragment = JSON.stringify({
    '@type': 'Hotel',
    address: { '@type': 'PostalAddress', streetAddress: '1 Example Street' },
  });
  assert.equal(extractFromStructuredData(ldJsonDocument(fragment)).status, 'not_found');
});

test('a coordinate still beats an address, from any tier', async () => {
  const { runExtraction } = await import('../src/extract/index.js');
  // Ordering matters: the rescue must not let a geocodable address outrank a published point.
  const doc = fakeDocument({
    'script[type="application/ld+json"]': [scriptNode(EXPEDIA_SHAPED)],
    'a[href], img[src], iframe[src]': [attrNode({ href: 'https://maps.google.com/?q=38.7115,-9.1287' })],
  });
  const { result } = runExtraction(doc);
  assert.equal(result.status, 'found');
  assert.equal(result.tier, 2);
});

// --- Codex review, PR #10 -----------------------------------------------------------------------

test('two lodging nodes with DIFFERENT addresses are ambiguous, not one merged address', () => {
  // Intersecting presence flags cannot tell a Lisbon hotel from a Tokyo one: both have a street, a
  // locality, a postcode and a country, so the merge reads as one complete address and describes
  // neither. The coordinate path already failed closed here; the address path did not.
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      address: { '@type': 'PostalAddress', streetAddress: '1 A St', addressLocality: 'Lisbon', postalCode: '1000-001', addressCountry: 'PT' },
    }),
    JSON.stringify({
      '@type': 'Hotel',
      address: { '@type': 'PostalAddress', streetAddress: '9 B St', addressLocality: 'Tokyo', postalCode: '100-0001', addressCountry: 'JP' },
    }),
  );
  const r = extractFromStructuredData(doc);
  assert.equal(r.status, 'ambiguous');
  // Components are dropped too — a presence map merged across two places is not evidence about
  // either, and exporting it would put a phantom address into the geocoding measurement.
  assert.equal(r.addressComponents, null);
});

test('the same address published twice is not a conflict', () => {
  // Pages repeat their listing across blocks constantly. Treating that as ambiguity would fail
  // closed on the ordinary case and measure nothing.
  const block = JSON.stringify({
    '@type': 'Hotel',
    address: { '@type': 'PostalAddress', streetAddress: '1 A St', addressLocality: 'Lisbon', postalCode: '1000-001', addressCountry: 'PT' },
  });
  assert.equal(extractFromStructuredData(ldJsonDocument(block, block)).status, 'found_address');
});

test('a country must be published, not merely non-null', () => {
  // `addressCountry: {}` passed a `!= null` check, so a postcode plus an empty object was reported
  // as a complete address and promoted to found_address. Every byte here is page-controlled.
  for (const hostile of [{}, [], 42, '   ', { name: '' }]) {
    const doc = ldJsonDocument(
      JSON.stringify({
        '@type': 'Hotel',
        address: { '@type': 'PostalAddress', postalCode: 'EX1 2AB', addressCountry: hostile },
      }),
    );
    const r = extractFromStructuredData(doc);
    assert.equal(r.status, 'not_found', `${JSON.stringify(hostile)} should not count as a country`);
    assert.equal(r.addressComponents.countryPublished, false);
  }
});

test('a nested Country object still counts as published', () => {
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      address: {
        '@type': 'PostalAddress',
        postalCode: 'EX1 2AB',
        addressLocality: 'Exampleton',
        addressCountry: { '@type': 'Country', name: 'United Kingdom' },
      },
    }),
  );
  const r = extractFromStructuredData(doc);
  assert.equal(r.addressComponents.countryPublished, true);
  assert.equal(r.status, 'found_address');
});

// --- Codex review round 2, PR #10 ---------------------------------------------------------------

test('a formatting difference does not discard a valid coordinate', () => {
  // The conflict check used to return immediately, so a page publishing the SAME point twice with
  // "1 Main Street" and "1 Main St" was refused over an abbreviation. A published point does not
  // become less true because the page abbreviates a street name.
  const doc = ldJsonDocument(
    JSON.stringify({
      '@type': 'Hotel',
      geo: { latitude: 38.7115, longitude: -9.1287 },
      address: { streetAddress: '1 Main Street', addressLocality: 'Lisbon', addressCountry: 'PT' },
    }),
    JSON.stringify({
      '@type': 'Hotel',
      geo: { latitude: 38.7115, longitude: -9.1287 },
      address: { streetAddress: '1 Main St', addressLocality: 'Lisbon', addressCountry: 'PT' },
    }),
  );
  const r = extractFromStructuredData(doc);
  assert.equal(r.status, 'found');
  // The components are still dropped: they disagreed, and they feed the geocoding measurement.
  assert.equal(r.addressComponents, null);
});

test('the same conflict still refuses the page when there is no coordinate to fall back on', () => {
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', address: { streetAddress: '1 Main Street', addressLocality: 'Lisbon', postalCode: 'A', addressCountry: 'PT' } }),
    JSON.stringify({ '@type': 'Hotel', address: { streetAddress: '1 Main St', addressLocality: 'Lisbon', postalCode: 'A', addressCountry: 'PT' } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'ambiguous');
});

test('two Springfields are told apart by their region', () => {
  // The first conflict check joined four fields into one string and omitted the region, so
  // Springfield, Illinois and Springfield, Massachusetts compared equal and merged into one address.
  const doc = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', address: { streetAddress: '1 Oak St', addressLocality: 'Springfield', addressRegion: 'IL', addressCountry: 'US' } }),
    JSON.stringify({ '@type': 'Hotel', address: { streetAddress: '1 Oak St', addressLocality: 'Springfield', addressRegion: 'MA', addressCountry: 'US' } }),
  );
  assert.equal(extractFromStructuredData(doc).status, 'ambiguous');
});

test('a city is not a listing', () => {
  // `country + locality` promoted "Lisbon, Portugal" to a successful read. Geocoding that returns
  // the city centre, which is not where the hotel is — and the report would have counted it as an
  // address we could locate. A wrong answer that looks like a success is the worst outcome here.
  const city = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', address: { addressLocality: 'Lisbon', addressCountry: 'PT' } }),
  );
  assert.equal(extractFromStructuredData(city).status, 'not_found');

  // A postcode pins it; so does a street with a locality to disambiguate it.
  const pinned = ldJsonDocument(
    JSON.stringify({ '@type': 'Hotel', address: { streetAddress: '1 Oak St', addressLocality: 'Lisbon', addressCountry: 'PT' } }),
  );
  assert.equal(extractFromStructuredData(pinned).status, 'found_address');
});
