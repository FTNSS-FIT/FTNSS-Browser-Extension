// The shape every extractor returns.
//
// There is deliberately no "return null on failure" anywhere in this codebase. A null forces every
// caller to decide what absence means, and the decision it invites is the wrong one: rendering an
// empty panel, which reads to a user as "FTNSS has no gyms here" rather than "we couldn't read this
// page". Those are different statements and one of them is false. Making failure an explicit,
// typed outcome means a caller has to handle it on purpose.

/** @typedef {'exact'|'approximate'} Precision */

/**
 * A successful read.
 * @param {object} o
 * @param {number} o.lat
 * @param {number} o.lon
 * @param {1|2|3} o.tier            which tier produced it
 * @param {string} o.source         a short, human-checkable note on where in the page it came from
 * @param {Precision} o.precision   'approximate' when the site publishes only an area by design
 */
export function found({ lat, lon, tier, source, precision }) {
  return { status: 'found', lat, lon, tier, source, precision };
}

/**
 * Tier 3 produces an address STRING, not a point — turning it into one needs a geocoder, which is a
 * network call, and this harness makes none. Kept as its own outcome rather than folded into
 * `found` so the report cannot silently count "we saw an address" as "we located the listing".
 * Those differ by exactly the geocoder's error rate, which phase 1 does not measure.
 */
export function foundAddress({ address, source }) {
  return { status: 'found_address', address, source, tier: 3 };
}

/**
 * This tier could not read the page. `reason` is for our own diagnosis, never for the user —
 * the user-facing message is always the same "we couldn't read this page".
 */
export function notFound(reason) {
  return { status: 'not_found', reason };
}

export const isFound = (r) => r != null && r.status === 'found';
export const isFoundAddress = (r) => r != null && r.status === 'found_address';
