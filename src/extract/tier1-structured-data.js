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
  addressesOverlap,
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
/**
 * How many DISTINCT lodging candidates a page may describe before we stop counting.
 *
 * Not a performance tuning knob so much as a statement about what a listing page is. Anything past
 * a couple of dozen distinct hotels is a search results page or a hostile one, and either way the
 * answer is the same refusal — so the work of telling them apart is work we never need to do.
 */
const MAX_CANDIDATES = 24;
/**
 * How close two published points must be to mean "the same building", as opposed to "not obviously
 * a contradiction".
 *
 * Much tighter than CONFLICT_METRES, and the difference is the point. That one answers "do these
 * two disagree", where a few hundred metres is noise. This one answers "are these the same hotel",
 * where a few hundred metres is a different hotel — reusing the loose threshold here merged two
 * listings 200m apart into one candidate and handed back whichever came first.
 *
 * Set at a large building's footprint. A page repeating its own block usually publishes the
 * identical coordinate, so most of this budget is spent on the case where the two copies were
 * geocoded from different sources and land a few tens of metres apart — which PR #1 decided
 * deliberately was still one listing. A JUDGEMENT, not a measurement: nobody has counted how far
 * apart a real page's two copies of one hotel actually land. It sits between "float noise", which
 * would be too tight to be useful, and CONFLICT_METRES, which is provably too loose.
 */
const IDENTITY_METRES = 50;

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
    streetNamesABuilding: a.streetNamesABuilding && b.streetNamesABuilding,
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

/**
 * Union, for two appearances of ONE hotel.
 *
 * The mirror of intersectComponents and used in the opposite place: within a candidate rather than
 * across candidates. A page that publishes its listing twice, once with the street and once with
 * the postcode, has told us both — intersecting them there dropped whatever either omitted, and a
 * candidate whose street came from the other appearance was reported as naming no building.
 */
function unionComponents(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return {
    street: a.street || b.street,
    streetNamesABuilding: a.streetNamesABuilding || b.streetNamesABuilding,
    locality: a.locality || b.locality,
    region: a.region || b.region,
    postalCode: a.postalCode || b.postalCode,
    countryPublished: a.countryPublished || b.countryPublished,
    countryParsed: a.countryParsed || b.countryParsed,
    // These appearances are the same hotel, so a country stated by either is the country. A
    // disagreement cannot arise: contradicting countries would have stopped them clustering.
    country: a.country ?? b.country,
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
   * EVERY lodging candidate the page described, in ONE collection.
   *
   * This started as two — a map keyed by `@id` and a separate list of clustered anonymous nodes —
   * and the split was itself a bug: one hotel published once with an `@id` and once without became
   * "several listings", and a page could be refused for describing itself twice in two different
   * styles. There is one question here, "how many distinct hotels is this page about", and it
   * deserves one mechanism. An `@id` is not a different KIND of identity, it is stronger evidence
   * of the same identity.
   *
   * A node joins a candidate when it shares an `@id` with it, or when it states BUILDING-LEVEL
   * evidence in common with it and contradicts nothing — the same street, or the same postcode
   * where a postcode names a building, or a point in the same building. Everything weaker was tried
   * and let a related-hotel block in: a shared country is a shared market, a shared locality is a
   * shared city, a shared US ZIP is a shared neighbourhood. None of them is a shared hotel.
   *
   * Components are UNIONED within a candidate and INTERSECTED across candidates, and the difference
   * matters: two appearances of one hotel each publishing part of its address describe one complete
   * address, while two different hotels describe only what they both happen to carry.
   * (Codex, PR #10.)
   */
  const candidateList = [];
  /** Set when the page described more distinct listings than MAX_CANDIDATES. */
  let candidateOverflow = false;
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
      const nodeCoordinates = coordinatesIn(node);
      const nodeValues = addressValuesOf(node);
      const nodePoint = nodeCoordinates.found
        ? { lat: nodeCoordinates.lat, lon: nodeCoordinates.lon }
        : null;
      const samePoint = (c) =>
        c.point != null && nodePoint != null && distanceMetres(c.point, nodePoint) <= IDENTITY_METRES;

      // FLAG, DO NOT RETURN. Returning here abandoned the coordinate search the moment two
      // addresses disagreed — so a page publishing the SAME point twice with "1 Main Street" and
      // "1 Main St" threw away a perfectly good coordinate over a formatting difference. The
      // conflict only matters if we end up answering FROM the address; a published point does not
      // become less true because the page abbreviates a street name. (Codex, PR #10.)
      if (nodeValues != null) {
        if (!addressesCompatible(addressSeen, nodeValues)) addressConflict = true;
        addressSeen = mergeAddressValues(addressSeen, nodeValues);
      }

      // BOUND THE WORK. Clustering compares each node against every candidate so far, and the
      // existing limits allow 25 scripts of lodging nodes — tens of millions of comparisons on a
      // hostile page, repeated by the readiness poll every 250ms until the tab stops responding.
      // The bound costs nothing real: a page describing more than MAX_CANDIDATES distinct hotels is
      // not a listing page, and it is already going to be refused as unattributable. Stop counting
      // and say so. (Codex, PR #10.)
      if (candidateList.length >= MAX_CANDIDATES) {
        candidateOverflow = true;
        break;
      }

      const candidate = candidateList.find((c) => {
        // An @id is the page telling us outright that these are one entity — but the page is the
        // thing we are being careful about. An `@id` is attacker-controlled text like everything
        // else here, and honouring it unconditionally meant two nodes could claim one identity
        // while publishing different addresses, merge, and hand back whichever coordinate one of
        // them carried. A claim of identity still has to survive the evidence. (Codex, PR #10.)
        if (identity != null && c.ids.has(identity)) {
          return addressesCompatible(c.values, nodeValues) &&
            (c.point == null || nodePoint == null || samePoint(c));
        }
        // A SHARED POINT IS THE STRONGEST EVIDENCE THERE IS, and it was being gated behind address
        // compatibility — so two nodes at the same coordinate whose streets read "1 Main Street"
        // and "1 Main St" failed to cluster, became two candidates, and the page was refused for
        // publishing one hotel twice. Same building, different spelling. The spelling disagreement
        // is still recorded, and still disqualifies the ADDRESS path; it has no business
        // disqualifying the point.
        if (samePoint(c)) return true;
        if (!addressesCompatible(c.values, nodeValues)) return false;
        if (c.point != null && nodePoint != null) return false; // different points, checked above
        return addressesOverlap(c.values, nodeValues);
      });

      if (candidate == null) {
        candidateList.push({
          ids: new Set(identity == null ? [] : [identity]),
          values: nodeValues,
          point: nodePoint,
          address: nodeComponents != null,
          coordinate: nodeCoordinates.found,
          components: nodeComponents,
        });
      } else {
        if (identity != null) candidate.ids.add(identity);
        candidate.values = mergeAddressValues(candidate.values, nodeValues);
        candidate.point = candidate.point ?? nodePoint;
        candidate.address = candidate.address || nodeComponents != null;
        candidate.coordinate = candidate.coordinate || nodeCoordinates.found;
        // UNION, not intersect. Two appearances of ONE hotel each carrying part of its address
        // describe one complete address between them; intersecting them dropped whatever either
        // omitted, and a candidate whose street came from the other appearance was then reported as
        // naming no building — the page called unreadable for publishing itself twice.
        candidate.components = unionComponents(candidate.components, nodeComponents);
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
  const seenCandidates = candidateList;
  const candidates = seenCandidates.length;
  const candidatesWithAddress = seenCandidates.filter((c) => c.address).length;
  if (candidateOverflow || (candidatesWithAddress > 0 && candidatesWithAddress < candidates)) {
    addressConflict = true;
  }
  // Recorded separately from the conflict, because it means something stronger: the PAGE is about
  // more than one place. A conflict between two addresses is about which of them we believe; this
  // is about whether any single answer can be attributed to the listing at all, and the runner
  // needs it to judge a lone map link. (Codex, PR #10.)
  const manyCandidates = candidates > 1 || candidateOverflow;

  // INTERSECT ACROSS CANDIDATES. A component counts as available only if EVERY distinct hotel on the
  // page has it, so the answer can understate viability but never overstate it. Within a candidate
  // the parts were unioned; the two directions are not interchangeable. (PR #8, and #10.)
  addressComponents = seenCandidates
    .map((c) => c.components)
    .filter((c) => c != null)
    .reduce((a, b) => (a == null ? b : intersectComponents(a, b)), null);

  // A merged presence map across two different places is not evidence about either, and it feeds
  // the geocoding measurement — so it is dropped whether or not a coordinate rescued the read.
  if (addressConflict) addressComponents = null;

  const withComponents = (result) => ({ ...result, addressComponents, manyCandidates });

  // THE COORDINATE HAS THE SAME ATTRIBUTION PROBLEM THE ADDRESS DID, and it was filed as #11 to be
  // decided against a lodging-node census rather than in the dark. It is fixed here instead,
  // because the failure it produces — the listing publishes no point, a "related hotel" block does,
  // and we report the related hotel's location as the listing's — is a confidently wrong location,
  // which is the outcome this project treats as worse than no answer at all.
  //
  // The cost is the risk #11 was written about: Airbnb reads 100% from this tier today, and if its
  // pages carry a lodging node without geo, those reads become ambiguous. The refusal carries its
  // own reason string so that shows up in the very next export rather than being inferred.
  // MORE THAN ONE CANDIDATE IS MORE THAN ONE HOTEL, however close their points happen to be.
  //
  // This used to allow a page through when EVERY candidate published a coordinate and they agreed
  // within CONFLICT_METRES — but agreement is not attribution. Two genuinely different hotels 200m
  // apart pass that test, and `best` is then whichever appeared first in document order, which has
  // never been a reason to think it is the one on screen. The error is bounded at a few hundred
  // metres rather than unbounded, which is exactly what made it easy to miss. (Codex, PR #10.)
  if (best != null && (candidateOverflow || candidates > 1)) {
    return withComponents(ambiguous('coordinates could not be attributed among several listings'));
  }

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
      manyCandidates,
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
