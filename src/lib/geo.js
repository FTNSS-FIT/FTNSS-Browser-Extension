// Coordinate handling. This module is the ONLY place a coordinate is prepared for transmission.
//
// Phase 1 sends nothing anywhere — there is no network code in this harness at all. The boundary
// exists anyway, and everything goes through it, because the invariant we need later is structural:
// "rounding happens in one place no caller can bypass". Establishing that now costs nothing;
// retrofitting it once several callers each round their own coordinate is how the guarantee quietly
// becomes a convention that mostly holds.

/**
 * Target transmission precision, in kilometres: cells 500m across, worst-case error ~348m.
 *
 * This was 1.11km, and that number was never derived — it was an artifact. The spec picked two
 * decimal places of latitude, which happens to be ~1.11km, because a reader could SEE the
 * truncation: 38.711503 becomes 38.71. That was a legibility argument.
 *
 * The legibility is already gone. Two decimal places is ~1.11km at the equator and ~190m at 80°N, so
 * the grid had to become latitude-aware — after which nobody can eyeball the rounding anyway, and we
 * were paying for a number whose only justification no longer applied.
 *
 * What the change costs and buys, measured:
 *
 *     1.11km cells → worst-case error 773m
 *     0.50km cells → worst-case error 348m
 *
 * 773m matters. The panel ranks the six NEAREST gyms and shows a distance, and an error of that size
 * reorders them and makes any distance we display suspect. 348m is inside what "a short walk" means.
 *
 * What it does not cost: a 500m cell still identifies no building and no hotel — it is a hundred
 * times coarser than a GPS fix, and in any city it contains dozens of buildings. The privacy
 * difference between 500m and 1.11km is small; the accuracy difference is not.
 *
 * (Jordan, 2026-07-31, on seeing that 1.11km was inherited rather than chosen.)
 */
export const TRANSMIT_KM = 0.5;

/** Degrees of latitude per kilometre is very nearly constant; degrees of longitude are not. */
const KM_PER_DEGREE_LATITUDE = 111.32;
const LATITUDE_STEP = TRANSMIT_KM / KM_PER_DEGREE_LATITUDE; // ~0.01°

/**
 * How many degrees of longitude make up TRANSMIT_KM at this latitude.
 *
 * THIS IS THE WHOLE POINT OF THIS FUNCTION. Meridians converge toward the poles, so a fixed 0.01°
 * of longitude is ~1.1km at the equator, ~380m at 70°, and ~190m at 80°. Rounding longitude to a
 * fixed two decimal places therefore delivered about a kilometre of privacy in Lisbon and a few
 * hundred metres in Tromsø — while the guarantee was stated, in the README and intended for the
 * store listing, as though it were uniform. It was weakest exactly where nobody had checked.
 *
 * Norway, Sweden and Finland are on this extension's own site list, so this is not a polar edge
 * case; it is a market we intend to serve. (Codex review round 9, PR #1.)
 */
function longitudeStepAt(latitude) {
  const cos = Math.cos((latitude * Math.PI) / 180);
  // NO UPPER CAP ON THE STEP. There was a `Math.min(1, …)` here, on the reasoning that a step of a
  // whole degree is coarser than anything the product needs. That reasoning is backwards: near the
  // pole you need a LARGER step in degrees to span the same distance, because the degrees themselves
  // are short. Capping at 1° produced 194m cells at 89.9° and 19m cells at 89.99° — the guarantee
  // failing hardest exactly where the correction was supposed to be doing the most work.
  // (Codex review round 15, PR #1.)
  if (cos <= 0) return Infinity;
  const ideal = LATITUDE_STEP / cos;

  // SNAP THE STEP TO ONE THAT DIVIDES 360° EXACTLY.
  //
  // Longitude is circular; an arbitrary step is not. With a step that does not divide the circle,
  // the cell boundaries do not line up across the antimeridian, so rounding an ALREADY-ROUNDED point
  // moves it — and because the storage boundary deliberately re-rounds (so no caller can bypass the
  // guarantee), that second pass shifted stored points by up to a full cell. Measured: (49.97,
  // -179.997) landed 1136m from its input, outside the ~1.11km the guarantee promises.
  //
  // Dividing the circle into a whole number of cells makes the grid genuinely circular and rounding
  // idempotent, which is also what lets an outside reader recompute our grid from a published point.
  // (Codex review round 22, PR #1.)
  const cells = Math.max(1, Math.round(360 / ideal));
  return 360 / cells;
}

/** A coordinate is only usable if it is a real number in range. Pages publish junk; some publish 0,0. */
/**
 * In range, and nothing more. Separate from `isUsableCoordinate` because the two questions differ:
 * whether a page's value is worth believing, and whether our own arithmetic produced a coordinate.
 *
 * Conflating them cost a real case. A listing genuinely near (0, 0) — the Gulf of Guinea, but also
 * anything within half a cell of the equator or the prime meridian — rounds ONTO Null Island, and
 * the Null Island heuristic then discarded it as though the input had been junk. The guard that
 * exists to catch broken page templates was throwing away correctly-rounded points.
 */
export function isInRange(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

export function isUsableCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // Null Island. Real listings are not at exactly 0,0; a page that says so has a broken template,
    // and treating it as a location would put a gym search in the Gulf of Guinea.
    !(lat === 0 && lon === 0)
  );
}

/**
 * Round to a grid whose cells are about TRANSMIT_KM across in BOTH directions, wherever on Earth the
 * point is. The ONLY function that may produce a coordinate for sending.
 *
 * Truncation vs rounding: this rounds. Truncating biases every point toward the equator and prime
 * meridian, which over many samples is a signal in itself. Rounding does not.
 *
 * The longitude step is derived from the ALREADY-ROUNDED latitude, so the grid is reproducible from
 * the output alone — anyone checking the claim can recompute it from the coordinate we published,
 * without needing the input we started from.
 */
export function toTransmittablePoint(lat, lon) {
  if (!isUsableCoordinate(lat, lon)) return null;

  // Rounding can push a point OUT of range at the edges of the coordinate system: 179.999 rounds up
  // to 180.001, and 89.999 to 90.0005. The storage boundary then re-rounds, finds the point
  // unusable, and stores `transmitted: null` — so a listing near the antimeridian (Fiji, New
  // Zealand, eastern Russia) or at extreme latitude silently lost its coordinate, and the loss
  // looked like an extraction failure rather than an arithmetic one.
  //
  // Latitude CLAMPS: there is nothing past the pole. Longitude WRAPS: 180.001°E is 179.999°W, a real
  // place, and clamping it there would move the point by two degrees.
  // (Codex review round 11, PR #1.)
  const clampLatitude = (value) => Math.min(90, Math.max(-90, value));
  const wrapLongitude = (value) => ((((value + 180) % 360) + 360) % 360) - 180;

  const roundedLat = clampLatitude(Math.round(lat / LATITUDE_STEP) * LATITUDE_STEP);
  const lonStep = longitudeStepAt(roundedLat);

  // Once one cell spans half the globe, longitude carries no usable information about where someone
  // is — every value maps to the same place. Canonicalising to 0 says that plainly instead of
  // publishing an arbitrary survivor of the arithmetic.
  const roundedLon =
    !Number.isFinite(lonStep) || lonStep >= 180
      ? 0
      : wrapLongitude(Math.round(lon / lonStep) * lonStep);

  // Trim floating-point noise. 6dp is far finer than any step above, so it never adds precision.
  const trim = (n) => Math.round(n * 1e6) / 1e6;
  const point = { lat: trim(roundedLat), lon: trim(wrapLongitude(trim(roundedLon))) };

  // Assert the postcondition rather than assume it — but assert the RIGHT one. This checks range
  // only: the input was already vetted by `isUsableCoordinate`, and re-applying the Null Island
  // heuristic here silently dropped every point that legitimately rounds onto (0, 0).
  return isInRange(point.lat, point.lon) ? point : null;
}

/**
 * Parse one coordinate field from page-supplied text. STRICT on purpose, and shared by every tier —
 * it lived in tier 1 only, and tier 2 used a bare `Number()`, which meant `?lat=&lng=20` produced
 * the perfectly valid-looking point `0, 20`. `Number('')` is `0`, and `0` is a real latitude, so
 * nothing downstream could tell that apart from a genuine reading. (Codex review, PR #1.)
 *
 * Numbers pass through. Strings must be a plain decimal. Everything else is refused rather than
 * coerced — a comma decimal ("38,7115") is indistinguishable from a truncated "lat,lon" pair, and
 * guessing wrong moves the point, which is the confidently-wrong failure this project cares most
 * about.
 */
export function parseCoordinate(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const trimmed = value.trim();
  if (trimmed === '') return NaN;
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return NaN;
  return Number(trimmed);
}

/** Great-circle distance in metres. Used only to score a measured read against ground truth. */
export function distanceMetres(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
