// Coordinate handling. This module is the ONLY place a coordinate is prepared for transmission.
//
// Phase 1 sends nothing anywhere — there is no network code in this harness at all. The boundary
// exists anyway, and everything goes through it, because the invariant we need later is structural:
// "rounding happens in one place no caller can bypass". Establishing that now costs nothing;
// retrofitting it once several callers each round their own coordinate is how the guarantee quietly
// becomes a convention that mostly holds.

/**
 * Target transmission precision, in kilometres. Roughly what 0.01° of LATITUDE is worth anywhere on
 * Earth — plenty to answer "is there a gym near this hotel", uselessly coarse as a location trail.
 */
export const TRANSMIT_KM = 1.11;

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
  // Near the poles the step tends to infinity. Clamp to 1°, coarser than anything the product needs,
  // which keeps the output finite and comparable.
  if (cos < LATITUDE_STEP) return 1;
  return Math.min(1, LATITUDE_STEP / cos);
}

/** A coordinate is only usable if it is a real number in range. Pages publish junk; some publish 0,0. */
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
  const roundedLat = Math.round(lat / LATITUDE_STEP) * LATITUDE_STEP;
  const lonStep = longitudeStepAt(roundedLat);
  const roundedLon = Math.round(lon / lonStep) * lonStep;
  // Trim floating-point noise. 6dp is far finer than any step above, so it never adds precision.
  const trim = (n) => Math.round(n * 1e6) / 1e6;
  return { lat: trim(roundedLat), lon: trim(roundedLon) };
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
