// Coordinate handling. This module is the ONLY place a coordinate is prepared for transmission.
//
// Phase 1 sends nothing anywhere — there is no network code in this harness at all. The boundary
// exists anyway, and everything goes through it, because the invariant we need later is structural:
// "rounding happens in one place no caller can bypass". Establishing that now costs nothing;
// retrofitting it once several callers each round their own coordinate is how the guarantee quietly
// becomes a convention that mostly holds.

/**
 * Transmission precision, in decimal places. Two places is ~1.1km of latitude — plenty to answer
 * "is there a gym near this hotel", uselessly coarse as a location trail.
 */
export const TRANSMIT_DECIMALS = 2;

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
 * Round toward ~1km. The ONLY function that may produce a coordinate for sending.
 *
 * Truncation vs rounding: this rounds. Truncating biases every point toward the equator and prime
 * meridian, which over many samples is a signal in itself. Rounding does not.
 */
export function toTransmittablePoint(lat, lon) {
  if (!isUsableCoordinate(lat, lon)) return null;
  const f = 10 ** TRANSMIT_DECIMALS;
  return {
    lat: Math.round(lat * f) / f,
    lon: Math.round(lon * f) / f,
  };
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
