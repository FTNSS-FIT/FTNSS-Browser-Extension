// The shape every extractor returns.
//
// There is deliberately no "return null on failure" anywhere in this codebase. A null forces every
// caller to decide what absence means, and the decision it invites is the wrong one: rendering an
// empty panel, which reads to a user as "FTNSS has no gyms here" rather than "we couldn't read this
// page". Those are different statements and one of them is false. Making failure an explicit,
// typed outcome means a caller has to handle it on purpose.

/**
 * @typedef {'approximate'|'unknown'} Precision
 *
 * There is deliberately no 'exact'. Nothing in this codebase can currently establish that a
 * published point is the building rather than a deliberately fuzzed area — that is a per-site fact
 * phase 1 exists to measure — and a value the code cannot justify is one it should not be able to
 * emit. The human records what they saw. (Codex review, PR #1.)
 */

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
 * The page carried coordinate evidence that DISAGREES WITH ITSELF.
 *
 * Distinct from `notFound`, and the distinction is the point. Absence means "look elsewhere", so an
 * ambiguous tier reported as absent let the runner fall through and answer from a lower tier — using
 * one of the very coordinates that was in dispute. Ambiguity means "stop": we have evidence, it
 * conflicts, and choosing between conflicting evidence is guessing. A confidently wrong location is
 * the failure this project cares about most, and it is worse than admitting we could not read the
 * page. (Codex review round 23, PR #1.)
 */
export function ambiguous(reason) {
  return { status: 'ambiguous', reason };
}

/**
 * This tier could not read the page. `reason` is for our own diagnosis, never for the user —
 * the user-facing message is always the same "we couldn't read this page".
 */
export function notFound(reason) {
  return { status: 'not_found', reason };
}

export const isFound = (r) => r != null && r.status === 'found';
export const isAmbiguous = (r) => r != null && r.status === 'ambiguous';
export const isFoundAddress = (r) => r != null && r.status === 'found_address';
