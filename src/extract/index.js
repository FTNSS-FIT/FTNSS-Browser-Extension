// The tiered runner. Tries structured data, then map links, then address text, and reports which
// tier answered and how long it took.
//
// ALL THREE TIERS ALWAYS RUN, even after one succeeds. In the shipped product that would be waste;
// here it is the point — we are measuring per-tier availability, and stopping at the first hit
// would make tiers 2 and 3 unmeasurable on exactly the pages where tier 1 works. The `result` field
// is what the product would have used; the `tiers` field is what we are here to learn.

import { extractFromStructuredData } from './tier1-structured-data.js';
import { extractFromMapLinks } from './tier2-map-links.js';
import { extractFromAddressText } from './tier3-address-text.js';
import { isFound, isFoundAddress, isAmbiguous, isAddressAmbiguous, ambiguous } from './result.js';
import { distanceMetres } from '../lib/geo.js';
import { textCorroboratesAddress } from './address-components.js';

/** Two coordinate-bearing tiers further apart than this are not describing the same listing. */
const CROSS_TIER_CONFLICT_METRES = 250;

function time(fn) {
  const start = performance.now();
  let value;
  try {
    value = fn();
  } catch (err) {
    // A page that makes an extractor throw must not take the panel down with it. The message is
    // kept for diagnosis; the error object is NOT, because it can carry page-derived context we
    // have no reason to hold on to.
    value = { status: 'not_found', reason: `threw: ${err && err.name ? err.name : 'Error'}` };
  }
  return { value, ms: Math.round((performance.now() - start) * 100) / 100 };
}

/**
 * @param {Document} doc
 * @returns {{
 *   result: object,
 *   tiers: {tier1: object, tier2: object, tier3: object},
 *   timing: {tier1Ms: number, tier2Ms: number, tier3Ms: number, totalMs: number}
 * }}
 */
export function runExtraction(doc) {
  const t1 = time(() => extractFromStructuredData(doc));
  const t2 = time(() => extractFromMapLinks(doc));
  const t3 = time(() => extractFromAddressText(doc));

  // AMBIGUITY STOPS THE READ; it is not a reason to try the next tier.
  //
  // A tier that found conflicting evidence used to report ordinary absence, and absence means "look
  // elsewhere" — so the runner fell through and answered from a lower tier, frequently using one of
  // the very coordinates that was in dispute. (Codex review round 23, PR #1.)
  //
  // ADDRESS AMBIGUITY IS NOT COORDINATE AMBIGUITY. Tier 1 can now be unsure which ADDRESS the page
  // describes while a map link publishes a perfectly good point, and collapsing the two stopped the
  // read — contradicting the coordinate-beats-address precedence three branches below. Address
  // ambiguity disqualifies the address fallback and nothing else. (Codex, PR #10.)
  const coordinateAmbiguity =
    (isAmbiguous(t1.value) && !isAddressAmbiguous(t1.value)) ||
    (isAmbiguous(t2.value) && !isAddressAmbiguous(t2.value));

  let result;
  if (coordinateAmbiguity) {
    result = ambiguous(
      isAmbiguous(t1.value) && !isAddressAmbiguous(t1.value) ? t1.value.reason : t2.value.reason,
    );
  } else if (isFound(t1.value) && isFound(t2.value) &&
             distanceMetres(t1.value, t2.value) > CROSS_TIER_CONFLICT_METRES) {
    // The tiers disagree with EACH OTHER. Checking conflicts only within a tier missed the case
    // where the structured data says one place and the map pin says another — the page contradicting
    // itself across sources, which is at least as strong a signal that we cannot tell.
    result = ambiguous('structured data and map link disagreed about the location');
  } else if (isFound(t1.value)) {
    // Precedence is tier order, and it is deliberate: a coordinate the site published for machines
    // beats a pin position, which beats a string we have not resolved.
    result = t1.value;
  } else if (isFound(t2.value)) {
    // A LONE MAP LINK ON A PAGE ABOUT SEVERAL PLACES CANNOT BE ATTRIBUTED.
    //
    // Round 3 established that an address disagreement must not veto a coordinate, and that stands:
    // two address blocks contradicting each other says nothing about a published point. But a page
    // whose structured data describes several DISTINCT lodging candidates is a different statement
    // — it is about more than one hotel, and a single pin somewhere on it belongs to whichever of
    // them nobody can say. Tier 1 already refuses that page; letting tier 2 answer it would route
    // around the refusal. (Codex, PR #10.)
    result = t1.value.manyCandidates === true
      ? ambiguous('structured data described two different places')
      : t2.value;
  } else if (isFoundAddress(t1.value) && isFoundAddress(t3.value) &&
             !textCorroboratesAddress(t1.value.addressValues, t3.value.address)) {
    // THE TIERS DISAGREE ABOUT WHICH ADDRESS. Tier 1 used to win here without ever being compared,
    // so a page whose JSON-LD describes a related hotel while the visible text describes the
    // listing recorded a confident successful read of the wrong property. Same check the coordinate
    // tiers have had since round 23, and the same conclusion: a page contradicting itself across
    // sources is a page we cannot read. (Codex, PR #10.)
    result = ambiguous('structured data and rendered address disagreed');
  } else if (isFoundAddress(t1.value)) {
    // A COORDINATE FROM ANY TIER STILL BEATS AN ADDRESS — that ordering is above this branch and is
    // the point of putting it here rather than with the tier-1 coordinate case. Between two
    // addresses, though, the structured one wins: tier 1 hands back separated components, and
    // whether the street can be withheld from a geocoder is answerable only when the parts arrive
    // apart. Tier 3 returns one rendered blob, which cannot be geocoded coarsely at all.
    result = t1.value;
  } else if (isAddressAmbiguous(t1.value)) {
    // No coordinate anywhere, and we cannot say whose address this is. Tier 3 must NOT rescue it:
    // the page conflicting with itself in structured data is not fixed by scraping the same page's
    // rendered text, which shows one of the very addresses in dispute.
    result = ambiguous(t1.value.reason);
  } else if (isFoundAddress(t3.value)) {
    result = t3.value;
  } else {
    result = { status: 'not_found', reason: 'all three tiers failed' };
  }

  // STRIP THE INTERNAL VALUES BEFORE ANYTHING LEAVES THIS MODULE.
  //
  // Tier 1 attaches the normalised address values so the corroboration above can run. They are a
  // street address — the listing's identity, and the one thing docs/DECISIONS.md 13 exists to keep
  // inside the browser. Storage projects through an allowlist and would have dropped them, but an
  // allowlist that is the only thing standing between an address and an export file is one edit
  // away from not being. Removed here, at the boundary that put them there.
  const shed = ({ addressValues, manyCandidates, ...rest }) => rest;

  return {
    // Which address components the page published, presence only — the question the geocoding
    // decision turns on, answerable without transmitting an address. (docs/DECISIONS.md 13.)
    addressComponents: t1.value.addressComponents ?? null,
    result: shed(result),
    tiers: { tier1: shed(t1.value), tier2: shed(t2.value), tier3: shed(t3.value) },
    timing: {
      tier1Ms: t1.ms,
      tier2Ms: t2.ms,
      tier3Ms: t3.ms,
      totalMs: Math.round((t1.ms + t2.ms + t3.ms) * 100) / 100,
    },
  };
}
