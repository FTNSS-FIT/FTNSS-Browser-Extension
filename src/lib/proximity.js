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
/** Generous against the agreed shape, tiny against anything that could hurt. */
const MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * Generous for a real gym path — the longest in production today is about 70 characters — and short
 * enough that nothing absurd is carried. Exceeding it rejects the path; see pathText.
 */
const MAX_PATH = 300;
/** Room for a server that over-returns, far short of one that has stopped honouring the contract. */
const MAX_RESPONSE_GYMS = 100;
/** A gym sells a handful of pass durations; anything past this is a different service answering. */
const MAX_PASSES = 12;

const text = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, MAX_TEXT) : null;

/**
 * A path is REJECTED when it is too long, never shortened.
 *
 * `text()` truncates, which is right for a name — a clipped gym name is cosmetic. It is wrong for a
 * path, because a truncated path is still a syntactically valid path: cutting
 * `/book/gyms/ca/ontario/toronto/some-very-long-gym-name` at the cap yields something that passes
 * every check and points at a DIFFERENT page. Truncation turns "too long to trust" into "a
 * confident link to the wrong gym", which is the failure this whole file is arranged to avoid.
 *
 * Found by self-review rather than by a reviewer — Codex is out of credits and this PR had none.
 */
function pathText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATH) return null;
  return trimmed;
}

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
    // PASSES, PRICE AND TODAY'S HOURS — everything the panel shows about a gym beyond its name.
    //
    // Rebuilt field by field like the rest, and bounded: `days` must be a positive integer, a price
    // must be a finite non-negative number, and a currency must be a three-letter code. A malformed
    // price is dropped rather than rendered, because a wrong number next to a gym is a claim about
    // what someone will be charged.
    passes: passesFrom(raw.passes),
    // { open: boolean, opensAt: "06:00", closesAt: "22:00" } — already resolved to the GYM's local
    // day by the server, which is the only place that knows its timezone. The extension must never
    // compute this: it would use the browser's clock and zone, and a traveller looking at a hotel
    // in another country is exactly the case that breaks.
    hours: hoursFrom(raw.hours),
    // A SITE-RELATIVE PATH, and only ever that. The gym page url is
    // /{locale}/book/gyms/{country}/{state}/{city}/{slug} — four segments this response does not
    // carry, so the client cannot build it and should not try: url structure belongs to the site
    // that serves it, and a client-side builder silently 404s the day routes are reorganised.
    //
    // Carried as an opaque string here and validated in locale.js before it becomes a link. It is
    // absent until the endpoint sends it, and a gym without one simply renders without a link.
    path: pathText(raw.path),
    // NOT raw.latitude / raw.longitude, which the agreed shape does not include. Returning the
    // query point and precise targets together would make the endpoint a triangulation oracle, and
    // a panel does not need them to render. If the server starts sending them anyway, this is where
    // they stop. (Admin's addition to the Phase 0 brief.)
  };
}

/** ISO 4217-shaped, uppercased. Never rendered raw — a currency is three letters or it is nothing. */
const currency = (value) =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null;

/**
 * The passes a gym sells, as {days, price, currency}.
 *
 * Bounded at MAX_PASSES because this drives a filter: an endpoint returning thousands would make
 * the panel build thousands of chips. Sorted by duration so the panel never depends on server order
 * for something it presents as an ordered set.
 */
function passesFrom(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_PASSES)) {
    if (item == null || typeof item !== 'object') continue;
    const days = item.days;
    if (!Number.isInteger(days) || days < 1 || days > 3660) continue;
    const price = typeof item.price === 'number' ? item.price : NaN;
    if (!Number.isFinite(price) || price < 0) continue;
    const code = currency(item.currency);
    if (code == null) continue;
    out.push({ days, price, currency: code });
  }
  return out.sort((a, b) => a.days - b.days);
}

/**
 * Today's opening hours for the gym, as the SERVER resolved them.
 *
 * `open` is authoritative and is not recomputed here. The gym's timezone is a fact the server has
 * and the extension does not, and a traveller browsing a hotel in another country is precisely the
 * case where using the browser's clock would be wrong — the same person, the same moment, a
 * different answer depending on where they happen to be sitting.
 */
function hoursFrom(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const time = (value) =>
    typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : null;
  const opensAt = time(raw.opensAt);
  const closesAt = time(raw.closesAt);
  if (typeof raw.open !== 'boolean' && opensAt == null) return null;
  return { open: raw.open === true, opensAt, closesAt };
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
export async function gymsNear({ lat, lon }, { endpoint, fetchImpl = fetch, signal } = {}) {
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
  // The CALLER may cancel too, and its reasons are different from ours: the timeout below is about
  // the server being slow, while the caller aborts because the answer stopped being wanted — the
  // endpoint changed, or a newer lookup replaced this one. Both must stop the same request.
  if (signal != null) {
    if (signal.aborted) return { status: 'error', reason: 'cancelled' };
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
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
    if (err?.name !== 'AbortError') return failed('network');
    // A caller's cancellation is not a timeout, and calling it one would put "timeout" in an export
    // for a request nobody was waiting for any more.
    return failed(signal?.aborted ? 'cancelled' : 'timeout');
  }

  if (!response.ok) return failed(`http ${response.status}`);

  // BOUND THE BODY WHILE READING IT, not after.
  //
  // `response.json()` reads to completion, so a gigabyte of JSON is parsed in full before any check
  // gets a look — and by then the abort timer has served its purpose, because the bytes did arrive.
  // `text()` moved the problem rather than fixing it: it still buffers the whole thing first, so
  // the advertised limit was checked on memory we had already committed. Streaming stops at the
  // limit and aborts the connection, which is the difference between a limit and a report.
  let raw;
  try {
    raw = await readBounded(response, controller);
  } catch (err) {
    if (err?.message === 'too large') return failed('response too large');
    return failed(err?.name === 'AbortError' ? 'timeout' : 'network');
  }
  clearTimeout(timer);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 'error', reason: 'unparseable response' };
  }

  if (!Array.isArray(payload?.gyms)) return { status: 'error', reason: 'no gyms array' };
  // A CONTRACT VIOLATION, NOT A LONG LIST TO TRIM. The endpoint returns at most six; anything
  // wildly beyond that is a different service, a rollback or a fault, and mapping and sorting it
  // first would do the expensive work before deciding not to trust it.
  if (payload.gyms.length > MAX_RESPONSE_GYMS) return { status: 'error', reason: 'too many gyms' };

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
 * Read a response body, stopping at MAX_RESPONSE_BYTES.
 *
 * Aborts the request on overflow rather than reading to the end and discarding — the point is not
 * to avoid holding a large string, it is to stop receiving one.
 */
async function readBounded(response, controller) {
  // Some environments (and every test double) have no stream. Falling back to text() is bounded by
  // whatever the caller sent, which is exactly the weakness being fixed — so it is used ONLY where
  // no stream exists, and the size is still checked.
  if (response.body?.getReader == null) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      controller.abort();
      throw new Error('too large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * "~400 m" / "~1.1 km". Never "385 m", and never a bare number.
 *
 * THIS WAS DELETED AND HAS COME BACK, so the reasoning is worth having in one place.
 *
 * It was removed because no phrasing could be made true at a boundary: the query point is a 250m
 * cell, so a reported 499m can be ~674m from the listing, and "under 500 m" is then simply false.
 * Four attempts — "390 m", "about 400 m", "under 500 m", nothing — each less wrong than the last
 * while the real problem stayed put.
 *
 * It is back because a gym list with no distances is a worse product, and Jordan is right that a
 * traveller needs some sense of how far. The resolution is to stop making CATEGORICAL claims and
 * make a marked estimate instead. "~1.1 km" asserts an approximation; "under 500 m" asserted a
 * bound, and a bound is the thing the grid can falsify. The tilde is load-bearing, and the panel
 * repeats it in words underneath.
 *
 * Rounded to 100m below a kilometre and 0.1km above — finer than the grid strictly justifies, and
 * defensible only because nothing here is presented as exact. (docs/DECISIONS.md 17.)
 */
export function describeDistance(metres) {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres < 1000) return `~${Math.max(100, Math.round(metres / 100) * 100)} m`;
  return `~${(metres / 1000).toFixed(1)} km`;
}
