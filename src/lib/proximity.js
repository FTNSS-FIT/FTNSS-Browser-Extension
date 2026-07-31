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
  // typeof, NOT Number(). `Number(null)` is 0 and `Number('')` is 0, both finite and both
  // non-negative — so a gym whose distance the server failed to compute rendered as "0 m", the most
  // confident possible statement built from the absence of an answer.
  if (typeof raw.distanceMetres !== 'number') return null;
  const metres = raw.distanceMetres;
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
  // The timer covers the WHOLE exchange, not just the headers. It used to be cleared as soon as
  // fetch resolved — which is when headers arrive, not when the body does — so a server that
  // answered and then stalled left the panel on "Searching…" forever. The most common way a
  // timeout fails to fire is being cancelled slightly too early.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const failed = (reason) => {
    clearTimeout(timer);
    return { status: 'error', reason };
  };

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
    return failed(err?.name === 'AbortError' ? 'timeout' : 'network');
  }

  if (!response.ok) return failed(`http ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return failed(err?.name === 'AbortError' ? 'timeout' : 'unparseable response');
  }
  clearTimeout(timer);

  if (!Array.isArray(payload?.gyms)) return { status: 'error', reason: 'no gyms array' };

  // THE SERVER MUST STATE THE RADIUS IT SEARCHED, on every response including an empty one.
  //
  // Treating the field as optional was the more forgiving reading and it was wrong in the case that
  // matters most: `{ gyms: [] }` alone became "no FTNSS gyms within 5km", which is a claim about
  // five kilometres made from a response that never mentioned a distance. An empty answer needs the
  // radius MORE than a full one does, because the radius is the entire content of what we then say.
  if (payload.searchRadiusMetres !== SEARCH_RADIUS_METRES) {
    return { status: 'error', reason: 'radius mismatch' };
  }

  // FILTER, THEN CAP — in that order. Capping first let unusable entries consume the six slots, so
  // a response carrying three malformed gyms and six good ones rendered three. The cap is meant to
  // bound what we show, not to be spent on things we were never going to show.
  const parsed = payload.gyms.map(gymFrom);

  // ONE BAD ENTRY POISONS THE WHOLE ANSWER, and dropping it quietly was worse than it looked.
  //
  // Filtering kept the readable gyms and discarded the rest — but the discarded one could be the
  // CLOSEST, and the panel then labels a farther gym "nearest" with complete confidence. The list
  // is an ordered claim, and an ordered claim cannot survive an unknown number of missing members.
  // Partial data is fine when you are counting; it is not fine when you are ranking.
  //
  // This also subsumes the all-invalid case: "we could not read the answer" is never "there is
  // nothing there". An empty panel reads as "FTNSS has no gyms here", which is a claim, and it must
  // not be made from a failure to parse.
  if (parsed.some((gym) => gym == null)) {
    return { status: 'error', reason: 'unreadable gym in the response' };
  }

  // SORT, THEN CAP. The panel says "nearest", and that word was being underwritten entirely by the
  // server's ordering — so a response that listed gyms by name, or by id, or by nothing in
  // particular would have had its seventh entry discarded regardless of it being the closest. We
  // assert what we display rather than trusting an ordering we did not compute.
  const gyms = parsed.sort((a, b) => a.distanceMetres - b.distanceMetres).slice(0, MAX_GYMS);

  // A genuinely empty list IS a success, and saying so here is what stops the panel crying failure
  // over the most common correct answer we have. Early in a marketplace's life, "no gyms near here"
  // is the true response almost everywhere on Earth, and it stays true until supply catches up.
  return gyms.length === 0 ? { status: 'empty' } : { status: 'ok', gyms };
}

/**
 * "about 400 m" / "about 2.4 km". Never "385 m".
 *
 * EVERY DISTANCE HERE IS APPROXIMATE, because the point we asked about was rounded to a 250m grid
 * before it left the browser. The true distance is up to ~175m either side of what comes back, so
 * "385 m" — which the first version of this rendered as "390 m" — was three digits of confidence
 * built on a number that does not have one. This repo's own rule is never to render precision it
 * does not have, and the panel was breaking it in the one place a user would act on the figure.
 *
 * Rounded to 100m below a kilometre, one decimal above, and "about" on all of it. Still finer than
 * the grid strictly justifies, and defensible: 100m is well inside "a short walk", and coarsening
 * to 250m would round a genuinely close gym up to "about 500 m" and lose the thing that matters.
 */
export function describeDistance(metres) {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres < 1000) return `about ${Math.max(100, Math.round(metres / 100) * 100)} m`;
  return `about ${(metres / 1000).toFixed(1)} km`;
}
