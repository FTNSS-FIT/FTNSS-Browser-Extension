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

import { found, notFound } from './result.js';
import { isUsableCoordinate } from '../lib/geo.js';

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
  'Place',
]);

const MAX_NODES = 500; // a page cannot make us walk forever
const MAX_DEPTH = 12;

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
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_NODES) {
    const [node, depth] = queue.shift();
    if (node == null || typeof node !== 'object' || depth > MAX_DEPTH) continue;
    seen += 1;
    if (Array.isArray(node)) {
      for (const child of node) queue.push([child, depth + 1]);
      continue;
    }
    yield node;
    for (const key of Object.keys(node)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      queue.push([node[key], depth + 1]);
    }
  }
}

/**
 * Coordinates arrive as numbers on some sites and as strings on others — both are valid schema.org.
 * Anything else (an object, an array, a number in a locale format we would have to guess at) is
 * refused rather than coerced. `Number('')` is 0, which is how a blank field becomes Null Island.
 */
function coerceCoordinate(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const trimmed = value.trim();
  if (trimmed === '') return NaN;
  // Reject anything that is not a plain decimal number. Leaves "38,7115" (comma decimal) refused
  // on purpose: we cannot tell it from a "lat,lon" pair, and guessing wrong moves the point.
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return NaN;
  return Number(trimmed);
}

function geoFrom(node) {
  const geo = node.geo;
  if (geo == null || typeof geo !== 'object' || Array.isArray(geo)) return null;
  const lat = coerceCoordinate(geo.latitude);
  const lon = coerceCoordinate(geo.longitude);
  if (!isUsableCoordinate(lat, lon)) return null;
  return { lat, lon };
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

  for (const script of scripts) {
    let parsed;
    try {
      // textContent, never innerHTML or eval. A JSON-LD block is data; treating it as anything
      // executable is the whole attack.
      parsed = JSON.parse(script.textContent || '');
    } catch {
      continue; // a malformed block is common and is not a reason to abandon the others
    }
    parsedAny = true;

    for (const node of walk(parsed)) {
      const types = typesOf(node);
      if (!types.some((t) => LODGING_TYPES.has(t))) continue;
      const geo = geoFrom(node);
      if (geo == null) {
        sawLodgingWithoutGeo = true;
        continue;
      }
      return found({
        lat: geo.lat,
        lon: geo.lon,
        tier: 1,
        source: `ld+json ${types[0]}.geo`,
        // The site published a point for this listing. Whether that point is the building or a
        // deliberately fuzzed area is a per-site fact we MEASURE rather than assume — see
        // docs/PHASE-1-MEASUREMENT.md. Recorded as exact here; the human verification step is what
        // establishes the truth, and marking it approximate on a hunch would bias the result.
        precision: 'exact',
      });
    }
  }

  if (!parsedAny) return notFound('ld+json present but none parsed');
  if (sawLodgingWithoutGeo) return notFound('lodging type found, no usable geo');
  return notFound('no lodging type in structured data');
}
