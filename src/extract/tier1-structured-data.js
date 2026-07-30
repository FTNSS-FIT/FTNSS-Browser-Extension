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
import { isUsableCoordinate, parseCoordinate } from '../lib/geo.js';

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

function geoFrom(node) {
  const geo = node.geo;
  if (geo == null || typeof geo !== 'object' || Array.isArray(geo)) return null;
  const lat = parseCoordinate(geo.latitude);
  const lon = parseCoordinate(geo.longitude);
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
  // Count every script VISITED, not every script accepted. Counting only the ones that passed the
  // size filter meant a page supplying thousands of oversized blocks still forced us to read every
  // single textContent out of the DOM — the cap advertised a bound it did not enforce.
  // (Codex review round 2, PR #1.)
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
      const geo = geoFrom(node);
      if (geo == null) {
        sawLodgingWithoutGeo = true;
        continue;
      }
      return found({
        lat: geo.lat,
        lon: geo.lon,
        tier: 1,
        // FIXED STRING. This used to interpolate the page's own `@type`, which is attacker
        // controlled — a page publishing `"@type": ["<anything at all>", "Hotel"]` put its own text
        // into a field we then wrote into an exported artifact. Diagnostic value is not worth
        // carrying page content forward. (Codex review round 3, PR #1.)
        source: 'ld+json.geo',
        // 'unknown', NOT 'exact'. Whether a published point is the building or a deliberately
        // fuzzed area is a per-site fact this phase exists to MEASURE. Claiming 'exact' without a
        // check is the repo's own "never render precision we do not have" rule broken in the one
        // place it was most likely to matter — a site that fuzzes location would have been recorded
        // as building-accurate on every single listing. The human records the precision verdict.
        // (Codex review, PR #1.)
        precision: 'unknown',
      });
    }
  }

  if (!parsedAny) return notFound('ld+json present but none parsed');
  if (sawLodgingWithoutGeo) return notFound('lodging type found, no usable geo');
  return notFound('no lodging type in structured data');
}
