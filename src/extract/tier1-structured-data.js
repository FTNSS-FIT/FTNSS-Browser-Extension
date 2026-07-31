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

import { found, foundAddress, notFound, ambiguous } from './result.js';
import {
  addressComponentsOf,
  describesAPlace,
  addressValuesOf,
  addressesCompatible,
  mergeAddressValues,
} from './address-components.js';
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
/** Conservative merge: a component survives only if both candidates have it. */
function intersectComponents(a, b) {
  return {
    street: a.street && b.street,
    locality: a.locality && b.locality,
    region: a.region && b.region,
    postalCode: a.postalCode && b.postalCode,
    countryPublished: a.countryPublished && b.countryPublished,
    countryParsed: a.countryParsed && b.countryParsed,
    // Only if they agree; two different countries on one page means we do not know which listing
    // this is, and a geocoder pointed at the wrong country returns nothing or somewhere wrong.
    country: a.country === b.country ? a.country : null,
  };
}

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
  // Captured from the same lodging node whether or not it carries coordinates — the case that
  // matters most is precisely the one where it does NOT, because that is the page that would need
  // geocoding. Presence only; see address-components.js for why.
  let addressComponents = null;
  /**
   * What the lodging addresses SAID, so a later one can be checked against them. Local only —
   * compared and dropped, never returned. See addressValuesOf.
   */
  let addressSeen = null;
  /** Set when two nodes state different things. Does NOT stop the coordinate search — see below. */
  let addressConflict = false;
  /**
   * How many lodging candidates the page described, and how many of them carried an address.
   *
   * An address-LESS node used to be skipped silently, so a page with the listing (no address) and a
   * "related hotel" (complete address) reported the related hotel's address as the listing's — with
   * no conflict to detect, because only one node had anything to compare. Unknown is compatible
   * between two addresses; it is not compatible between an address and a node that has none, once
   * the address is the answer. (Codex, PR #10.)
   */
  /**
   * Keyed by `@id` so a page that REFERENCES its listing does not look like a second listing.
   *
   * schema.org graphs routinely carry the same entity twice — once as a stub with only an `@id`,
   * once in full — and counting those as two candidates made a page disagree with itself for
   * publishing a cross-reference. Same `@id` means same entity by definition, so they are folded
   * together and the candidate has an address if ANY of its appearances did. Nodes without an
   * `@id` cannot be identified with anything and each count alone. (Codex, PR #10.)
   */
  const lodgingCandidates = new Map();
  let anonymousLodging = 0;
  let anonymousWithAddress = 0;
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
      // INTERSECT across every lodging node, never take the first.
      //
      // Taking the first meant a page carrying a complete "related hotel" node ahead of an
      // incomplete target node was reported as coarse-geocodable when the listing itself was not —
      // the same first-wins mistake as the coordinate tiers, in the one place it had not been fixed.
      // Intersecting is the conservative reading: a component counts as available only if EVERY
      // candidate has it, so the answer can understate viability but never overstate it.
      // (Codex review, PR #8.)
      const nodeComponents = addressComponentsOf(node);
      const identity = typeof node['@id'] === 'string' && node['@id'].trim().length > 0
        ? node['@id'].trim()
        : null;
      if (identity == null) {
        anonymousLodging += 1;
        if (nodeComponents != null) anonymousWithAddress += 1;
      } else {
        lodgingCandidates.set(identity, (lodgingCandidates.get(identity) ?? false) || nodeComponents != null);
      }
      if (nodeComponents != null) {
        // FAIL CLOSED WHEN TWO NODES DESCRIBE DIFFERENT PLACES — the address path's version of the
        // coordinate check below, and it was missing. Intersecting presence flags across a Lisbon
        // hotel and a Tokyo hotel yields street+locality+postcode+country all true, which reads as
        // one complete address and describes neither. A page publishing a "similar properties"
        // block is enough to trigger it, and after the tier-1 change that merged phantom was
        // promoted to `found_address`. A confident address for the wrong hotel geocodes to a
        // confident coordinate for the wrong hotel.
        // FLAG, DO NOT RETURN. Returning here abandoned the coordinate search the moment two
        // addresses disagreed — so a page publishing the SAME point twice with "1 Main Street" and
        // "1 Main St" threw away a perfectly good coordinate over a formatting difference. The
        // conflict only matters if we end up answering FROM the address; a published point does not
        // become less true because the page abbreviates a street name. (Codex, PR #10.)
        const values = addressValuesOf(node);
        if (values != null) {
          if (!addressesCompatible(addressSeen, values)) addressConflict = true;
          addressSeen = mergeAddressValues(addressSeen, values);
        }
        addressComponents =
          addressComponents == null ? nodeComponents : intersectComponents(addressComponents, nodeComponents);
      }
      const coordinates = coordinatesIn(node);
      if (coordinates.conflicting) {
        return { ...ambiguous('structured data described two different places'), addressComponents };
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

  // UNATTRIBUTABLE IS AS BAD AS CONFLICTING. If some lodging candidates carry an address and
  // others do not, we have an address and no way to say whose it is — which is exactly the state
  // that produces a confident answer about the wrong hotel.
  const candidates = lodgingCandidates.size + anonymousLodging;
  const candidatesWithAddress =
    [...lodgingCandidates.values()].filter(Boolean).length + anonymousWithAddress;
  if (candidatesWithAddress > 0 && candidatesWithAddress < candidates) addressConflict = true;

  // A merged presence map across two different places is not evidence about either, and it feeds
  // the geocoding measurement — so it is dropped whether or not a coordinate rescued the read.
  if (addressConflict) addressComponents = null;

  const withComponents = (result) => ({ ...result, addressComponents });

  if (best != null) {
    // EXPLICITLY attached, via the same wrapper as every other return.
    //
    // This used to pass `addressComponents` inside the `found()` argument, where it was silently
    // discarded — `found()` builds a fixed shape. Harmless while nothing depended on it, and a trap
    // now that a conflict must clear the components: anyone adding the field to `found()`'s shape
    // would have started leaking a merged phantom address onto coordinate-bearing pages. It also
    // means we now learn which components a site publishes even when it publishes a point, which is
    // the question every geocoding decision turns on and was being thrown away for free.
    return withComponents(found({
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
    }));
  }

  if (!parsedAny) return withComponents(notFound('ld+json present but none parsed'));

  // NO COORDINATES IS NOT NO ANSWER.
  //
  // Reaching here with a complete PostalAddress in hand and reporting `not_found` was wrong, and
  // wrong in the direction that costs most: it made a site that publishes addresses-without-
  // coordinates — the Booking shape, and the shape Expedia and Hotels.com turn out to share —
  // indistinguishable from a site we cannot read at all. Those call for opposite responses. One
  // needs a geocoder; the other needs a different extraction strategy or dropping the site.
  //
  // The diagnostic reason is carried THROUGH rather than replaced. "lodging type found, no
  // coordinates published" is the finding about the site, and it stays true and stays recorded
  // whether or not an address rescued the read.
  const reason = sawUnusableGeo
    ? 'lodging type found, coordinates present but refused'
    : sawLodgingWithoutGeo
      ? 'lodging type found, no coordinates published'
      : 'no lodging type in structured data';

  // Only NOW does the address conflict decide anything: we are about to answer from the address.
  if (addressConflict) {
    return {
      // SCOPED. This ambiguity is about the address only; a coordinate tier below is still free to
      // answer, and the runner relies on that distinction.
      ...ambiguous('structured data described two different places', 'address'),
      addressComponents: null,
    };
  }

  if (describesAPlace(addressComponents)) {
    return withComponents(
      foundAddress({
        // `address: null` — presence, never values. See result.js.
        source: 'ld+json.address',
        tier: 1,
        reason,
        // FOR THE RUNNER'S CROSS-TIER CHECK, AND NOTHING ELSE. The runner strips this before the
        // extraction leaves this module, so it never reaches the popup, storage or an export — see
        // index.js. It exists because corroborating tier 1 against tier 3 needs the values, and the
        // only alternative was to hand the same values to every caller and trust each of them.
        addressValues: addressSeen,
      }),
    );
  }

  // Two different findings, deliberately not collapsed into one reason.
  return withComponents(notFound(reason));
}
