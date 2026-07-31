// Tier 1 — schema.org structured data.
//
// Booking sites publish a machine-readable block so search engines can show rich results. It is
// maintained carefully for their own commercial benefit, changes rarely (the format is fixed by an
// external standard rather than by their designers), and is identical across sites. That is why it
// is the robust path and the layout is not.
//
// SECURITY: every byte here is attacker-controlled. A page can publish any JSON it likes — wrong
// types, 40-deep nesting, a `__proto__` key, a `geo` that is a string. Nothing below trusts a shape
// it has not checked, and nothing is copied wholesale out of the parsed object.

import { found, notFound, ambiguous } from './result.js';
import { isUsableCoordinate, parseCoordinate, distanceMetres } from '../lib/geo.js';

/**
 * How far apart two candidates may be and still be treated as the same listing.
 *
 * This was 2000m — nearly twice the ~1.11km cell the protocol defines correctness within. So a page
 * could place an unrelated coordinate first and the real one 1500m later, the two would be judged to
 * "agree", and the unrelated point would be returned with confidence and scored as a hit. A
 * disagreement threshold looser than the correctness bound is not a check; it is a way of certifying
 * wrong answers.
 *
 * 250m instead: two records genuinely describing one building are far closer than that, and anything
 * beyond it is a question we should refuse rather than resolve. (Codex review round 18, PR #1.)
 */
const CONFLICT_METRES = 250;

/** Types whose `geo` we will believe. A `geo` on an arbitrary type is not a listing's location. */
const LODGING_TYPES = new Set([
  'Hotel',
  'Motel',
  'Hostel',
  'Resort',
  'BedAndBreakfast',
  'LodgingBusiness',
  'Apartment',
  'ApartmentComplex',
  'House',
  'SingleFamilyResidence',
  'Accommodation',
  'VacationRental',
  'Campground',
  // NO generic 'Place'. It is schema.org's base type for anything with a location — a landmark, a
  // restaurant, a city, an airport — so accepting it meant any nearby point of interest the page
  // happened to describe could be returned as the listing's own position.
  // (Codex review round 17, PR #1.)
]);

const MAX_NODES = 500; // objects examined
const MAX_ENQUEUED = 5000; // total entries the page can make us queue
const MAX_DEPTH = 12;
// Caps applied BEFORE parsing. The node/depth limits above only bound the walk — a single
// multi-megabyte block still had to be read out of the DOM and run through JSON.parse first, so a
// page could burn memory and main-thread time for free before any of our limits applied.
// (Codex review, PR #1.)
const MAX_SCRIPTS = 25;
const MAX_JSON_CHARS = 512 * 1024;

/** `@type` may be a string or an array. Normalise, and ignore anything that is neither. */
function typesOf(node) {
  const t = node['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x) => typeof x === 'string');
  return [];
}

/**
 * Walk the parsed JSON breadth-first, yielding plain objects. Bounded in both node count and depth:
 * an unbounded walk over page-supplied JSON is a denial-of-service the page controls for free.
 *
 * Keys are read with a null-prototype guard — a page can publish `"__proto__": {...}`, and while
 * JSON.parse itself does not assign it, code that later spreads or merges these nodes would.
 */
function* walk(root) {
  // Bounded on ENQUEUES and dequeues, not on objects yielded. The previous cap counted only nodes
  // that turned out to be objects, so a 512KB array of primitives could push hundreds of thousands
  // of entries that were each dequeued and discarded without ever incrementing the counter. And the
  // queue was drained with `shift()`, which is O(n) on an array, making that same input quadratic —
  // a page could freeze the tab while staying inside every limit this function advertised.
  // An index cursor makes dequeuing O(1); the enqueue cap makes the advertised bound real.
  // (Codex review round 8, PR #1.)
  const queue = [[root, 0]];
  let cursor = 0;
  let enqueued = 1;
  let yielded = 0;

  while (cursor < queue.length && yielded < MAX_NODES) {
    const [node, depth] = queue[cursor];
    // Release the reference so a large discarded subtree can be collected while we walk on.
    queue[cursor] = null;
    cursor += 1;

    if (node == null || typeof node !== 'object' || depth > MAX_DEPTH) continue;

    const children = Array.isArray(node)
      ? node
      : (yielded += 1, yield node, Object.keys(node)
          .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
          .map((k) => node[k]));

    for (const child of children) {
      if (enqueued >= MAX_ENQUEUED) return;
      // Primitives cannot contain anything; not enqueuing them is what makes the bound meaningful
      // on a large flat array rather than merely eventual.
      if (child == null || typeof child !== 'object') continue;
      enqueued += 1;
      queue.push([child, depth + 1]);
    }
  }
}

/**
 * Where schema.org allows coordinates to live. We were only looking in one of these places.
 *
 * `geo` is the common form, but `latitude`/`longitude` directly on the Place are equally valid and
 * some sites publish them that way. Looking only under `geo` meant a listing that published its
 * coordinates in the other standard location read as having none — indistinguishable, in the data,
 * from a site that genuinely withholds them. That is the difference between "a market we cannot
 * serve" and "a bug in our reader", which is the most consequential distinction this phase makes.
 */
function coordinatesIn(node) {
  const candidates = [];
  const geo = node.geo;
  if (geo != null && typeof geo === 'object' && !Array.isArray(geo)) candidates.push(geo);
  // An array of GeoCoordinates is unusual but valid.
  if (Array.isArray(geo)) candidates.push(...geo.filter((g) => g != null && typeof g === 'object'));
  // The node itself, for `"latitude": …, "longitude": …` published directly on the Place.
  candidates.push(node);

  // EVERY candidate, not the first usable one. Returning early meant two conflicting entries inside
  // one lodging object — a `geo` array with two different points — bypassed the ambiguity check
  // entirely, because the check never saw the second. (Codex review, PR #6.)
  const usable = [];
  let sawUnusable = false;
  for (const candidate of candidates) {
    const lat = parseCoordinate(candidate.latitude);
    const lon = parseCoordinate(candidate.longitude);
    if (isUsableCoordinate(lat, lon)) {
      usable.push({ lat, lon });
      continue;
    }
    // A coordinate-shaped pair that we refused tells us something different from no pair at all.
    if (candidate.latitude != null || candidate.longitude != null) sawUnusable = true;
  }

  for (const point of usable.slice(1)) {
    if (distanceMetres(usable[0], point) > CONFLICT_METRES) {
      return { found: false, conflicting: true };
    }
  }

  if (usable.length > 0) return { found: true, lat: usable[0].lat, lon: usable[0].lon };
  return { found: false, sawUnusable };
}

/**
 * @param {Document} doc
 * @returns {{status:'found'}|{status:'not_found'}}
 */
export function extractFromStructuredData(doc) {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  if (scripts.length === 0) return notFound('no ld+json blocks on page');

  let parsedAny = false;
  let sawLodgingWithoutGeo = false;
  let sawUnusableGeo = false;
  /** The first usable lodging coordinate; every later one must agree with it. */
  let best = null;
  let visited = 0;

  for (const script of scripts) {
    if (visited >= MAX_SCRIPTS) break;
    visited += 1;
    const raw = script.textContent || '';
    if (raw.length === 0 || raw.length > MAX_JSON_CHARS) continue;

    let parsed;
    try {
      // textContent, never innerHTML or eval. A JSON-LD block is data; treating it as anything
      // executable is the whole attack.
      parsed = JSON.parse(raw);
    } catch {
      continue; // a malformed block is common and is not a reason to abandon the others
    }
    parsedAny = true;

    for (const node of walk(parsed)) {
      const types = typesOf(node);
      if (!types.some((t) => LODGING_TYPES.has(t))) continue;
      const coordinates = coordinatesIn(node);
      if (coordinates.conflicting) {
        return ambiguous('structured data described two different places');
      }
      if (!coordinates.found) {
        // Distinguish "no coordinates published" from "coordinates published in a form we refused".
        // Reported as separate reasons, because the first is a finding about the site and the second
        // is a finding about us, and they call for opposite responses.
        if (coordinates.sawUnusable) sawUnusableGeo = true;
        else sawLodgingWithoutGeo = true;
        continue;
      }
      const geo = { lat: coordinates.lat, lon: coordinates.lon };

      // FAIL CLOSED WHEN THE PAGE DESCRIBES TWO PLACES.
      //
      // Returning the first lodging object assumed a page describes one listing. A hostile or merely
      // busy page can publish several — a "similar properties" block, a parent chain entry — and the
      // first in document order need not be the one on screen. Same reasoning as the map-link tier:
      // a confident coordinate for the wrong hotel is worse than no coordinate at all.
      // (Codex review round 17, PR #1.)
      if (best != null && distanceMetres(best, geo) > CONFLICT_METRES) {
        return ambiguous('structured data described two different places');
      }
      if (best == null) best = geo;
    }
  }

  if (best != null) {
    return found({
      lat: best.lat,
      lon: best.lon,
      tier: 1,
      // FIXED STRING. This used to interpolate the page's own `@type`, which is attacker-controlled:
      // a page publishing `"@type": ["<anything at all>", "Hotel"]` put its own text into a field we
      // then wrote into an exported artifact. Diagnostic value is not worth carrying page content
      // forward. (Codex review round 3, PR #1.)
      source: 'ld+json.geo',
      // 'unknown', NOT 'exact'. Whether a published point is the building or a deliberately fuzzed
      // area is a per-site fact this phase exists to MEASURE. Claiming 'exact' without a check is
      // this repo's own "never render precision we do not have" rule broken in the one place it was
      // most likely to matter — a site that fuzzes location would have been recorded as
      // building-accurate on every single listing. The person records the precision verdict.
      // (Codex review round 1, PR #1.)
      precision: 'unknown',
    });
  }

  if (!parsedAny) return notFound('ld+json present but none parsed');
  // Two different findings, deliberately not collapsed into one reason.
  if (sawUnusableGeo) return notFound('lodging type found, coordinates present but refused');
  if (sawLodgingWithoutGeo) return notFound('lodging type found, no coordinates published');
  return notFound('no lodging type in structured data');
}
