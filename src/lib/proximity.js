// The one place this extension talks to a network, and the only place it ever will.
//
// Everything the repo promises about privacy is enforced here or nowhere. The promise is not "we
// try not to send your location" — it is "the code that could send a precise location does not
// exist", and that is a claim an auditor checks by reading this file and finding that the ONLY
// coordinate it can construct comes out of toTransmittablePoint().
//
// So: no raw coordinate reaches fetch, no page identity is available to send, and the request body
// is built field by field rather than by spreading an object a caller handed us. A body assembled
// by spread is a body whose contents depend on every caller forever.

import { toTransmittablePoint, isUsableCoordinate } from './geo.js';

/** Beyond this, "near your hotel" stops being true. Mirrored server-side; sent so the two can be compared. */
export const SEARCH_RADIUS_METRES = 5000;

/**
 * How long to wait before giving up.
 *
 * Short on purpose. This runs while somebody is looking at a panel, and a spinner that resolves
 * after eight seconds is worse than an honest "couldn't reach FTNSS" after four — they have already
 * decided nothing is happening, and the late answer arrives as a flicker.
 */
const TIMEOUT_MS = 4000;

/** A gym name that is longer than this is not a gym name. Server-controlled text still gets bounded. */
const MAX_TEXT = 120;
/** DECISIONS.md 12. The server also limits; a client that trusts a count it did not enforce is not limiting. */
const MAX_GYMS = 6;

const text = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, MAX_TEXT) : null;

/**
 * Rebuild each gym field by field.
 *
 * The response is trusted less than it looks like it should be. It comes from our own server, but
 * "our own server" is a claim about DNS and TLS, and this is a public repo whose endpoint anyone can
 * point at anything by editing one setting. Rendering is via textContent so there is no injection
 * here, but a field we do not read cannot be displayed by accident later either — including one the
 * server should never have sent, like a coordinate or a contact email.
 */
function gymFrom(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const name = text(raw.name);
  if (name == null) return null;
  const metres = Number(raw.distanceMetres);
  if (!Number.isFinite(metres) || metres < 0 || metres > SEARCH_RADIUS_METRES) return null;
  return {
    id: text(raw.id),
    name,
    slug: text(raw.slug),
    city: text(raw.city),
    distanceMetres: Math.round(metres),
    // NOT raw.latitude / raw.longitude, which the agreed shape does not include. Returning the
    // query point and precise targets together would make the endpoint a triangulation oracle, and
    // a panel does not need them to render. If the server starts sending them anyway, this is where
    // they stop. (Admin's addition to the Phase 0 brief.)
  };
}

/**
 * Ask what is near a point.
 *
 * @returns {Promise<{status:'ok'|'empty'|'unconfigured'|'error', gyms?: object[], reason?: string}>}
 *
 * Every outcome is named, and `error` carries a reason for us rather than for the user. The user
 * sees one sentence in all failure cases, because "couldn't reach FTNSS" and "FTNSS returned
 * nonsense" are the same event to somebody looking at a hotel — and the difference between them is
 * a detail about our infrastructure that a page we do not control should not be able to probe for.
 */
export async function gymsNear({ lat, lon }, { endpoint, fetchImpl = fetch } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { status: 'unconfigured' };
  }
  // The rounding is not a formatting step and must not be skippable. A caller passing an already
  // rounded point loses nothing by it being rounded again — the grid is idempotent, which is why
  // longitudeStepAt() snaps to a divisor of 360.
  if (!isUsableCoordinate(lat, lon)) return { status: 'error', reason: 'unusable coordinate' };
  const point = toTransmittablePoint(lat, lon);
  if (point == null) return { status: 'error', reason: 'coordinate did not survive rounding' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // NO COOKIES. `omit` rather than the default, and it is the point rather than a tidy-up: an
      // authenticated request re-identifies the person, which is exactly what rounding the
      // coordinate was for. Sending a coarse point alongside a session cookie would be a privacy
      // guarantee cancelled by its own transport.
      credentials: 'omit',
      // Do not follow a redirect to somewhere we did not agree to send a location.
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      // Field by field. There is no page identity in scope here to leak even by accident, which is
      // a property of the call site as much as of this line.
      body: JSON.stringify({ lat: point.lat, lon: point.lon }),
    });
  } catch (err) {
    return { status: 'error', reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { status: 'error', reason: `http ${response.status}` };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: 'error', reason: 'unparseable response' };
  }

  if (!Array.isArray(payload?.gyms)) return { status: 'error', reason: 'no gyms array' };
  // FILTER, THEN CAP — in that order. Capping first let unusable entries consume the six slots, so
  // a response carrying three malformed gyms and six good ones rendered three. The cap is meant to
  // bound what we show, not to be spent on things we were never going to show.
  const gyms = payload.gyms.map(gymFrom).filter(Boolean).slice(0, MAX_GYMS);

  // EMPTY IS A SUCCESS, and saying so here is what stops the panel rendering "something went wrong"
  // over the most common correct answer we have. Early in a marketplace's life, "no gyms near here"
  // is the true response almost everywhere on Earth, and it stays true until supply catches up.
  return gyms.length === 0 ? { status: 'empty' } : { status: 'ok', gyms };
}

/**
 * "380 m" / "about 2.4 km".
 *
 * Two significant figures above a kilometre, and never three: the point transmitted was rounded to
 * a 250m grid, so "2.43 km" would be claiming a precision the coordinate cannot support. The word
 * "about" is doing honest work.
 */
export function describeDistance(metres) {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `about ${(metres / 1000).toFixed(1)} km`;
}
