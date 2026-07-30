// Tier 2 — coordinates embedded in map links and static map images.
//
// Nearly every listing page has a map on it. For the pin to land in the right place the position
// has to be present in the link or image URL, so it is sitting in plain sight. Stable for the same
// reason as Tier 1: the site needs it correct for their own feature to work.
//
// SECURITY: these are attacker-supplied URLs read from the page. We parse them with the URL API
// rather than by hand, we never navigate to them, and we never send them anywhere.

import { found, notFound, ambiguous } from './result.js';
import { isUsableCoordinate, parseCoordinate, distanceMetres } from '../lib/geo.js';

// Nodes VISITED, not nodes that looked map-shaped. Counting only the ones that passed the prefilter
// meant a page full of ordinary links forced an unbounded walk while staying inside a cap that
// claimed to prevent exactly that. (Codex review round 11, PR #1.)
const MAX_ELEMENTS = 1500;
const MAX_URL_CHARS = 2000;
/**
 * How far apart two map candidates may be and still be treated as the same place.
 *
 * Was 2000m, which is looser than the ~1.11km within which the protocol defines a read as correct —
 * so two points could "agree" while being far enough apart that at most one of them could ever have
 * been right. A threshold looser than the correctness bound certifies wrong answers rather than
 * catching them. (Codex review round 18, PR #1.)
 */
const CONFLICT_METRES = 250;

/** `?ll=38.71,-9.12`, `?center=…`, `?q=…` — a lat,lon pair in a single query parameter. */
const PAIR_PARAMS = ['ll', 'center', 'sll', 'cbll', 'q', 'query', 'markers', 'location'];
/** Sites that split the pair across two parameters. */
const LAT_PARAMS = ['lat', 'latitude', 'maplat'];
const LON_PARAMS = ['lon', 'lng', 'long', 'longitude', 'maplon', 'maplng'];

const NUM = '[+-]?\\d{1,3}(?:\\.\\d+)?';
const PAIR_RE = new RegExp(`^(${NUM})\\s*,\\s*(${NUM})$`);
/** Google's `@lat,lon,zoom` path form. */
const AT_RE = new RegExp(`@(${NUM}),(${NUM})`);

function fromPair(text) {
  const m = PAIR_RE.exec(String(text).trim());
  if (m == null) return null;
  // Safe here regardless (PAIR_RE already guarantees a plain decimal), but every coordinate in this
  // codebase goes through the one parser — an exception that is currently harmless is how the next
  // one gets added without argument.
  const lat = parseCoordinate(m[1]);
  const lon = parseCoordinate(m[2]);
  return isUsableCoordinate(lat, lon) ? { lat, lon } : null;
}

function readUrl(raw) {
  let url;
  try {
    // A base is required for protocol-relative and root-relative URLs. document.baseURI would be
    // page-controlled either way; this only ever affects parsing, never a request, because nothing
    // here fetches or navigates.
    url = new URL(raw, 'https://example.invalid');
  } catch {
    return null;
  }

  for (const key of PAIR_PARAMS) {
    const value = url.searchParams.get(key);
    if (value != null) {
      const hit = fromPair(value);
      if (hit != null) return { ...hit, source: `map url ?${key}` };
    }
  }

  for (const latKey of LAT_PARAMS) {
    const latRaw = url.searchParams.get(latKey);
    if (latRaw == null) continue;
    for (const lonKey of LON_PARAMS) {
      const lonRaw = url.searchParams.get(lonKey);
      if (lonRaw == null) continue;
      // parseCoordinate, NOT Number(): `?lat=&lng=20` would otherwise become the valid-looking
      // point `0, 20`, because Number('') is 0 and 0 is a real latitude. (Codex review, PR #1.)
      const lat = parseCoordinate(latRaw);
      const lon = parseCoordinate(lonRaw);
      if (isUsableCoordinate(lat, lon)) {
        return { lat, lon, source: `map url ?${latKey}/${lonKey}` };
      }
    }
  }

  const at = AT_RE.exec(url.pathname);
  if (at != null) {
    const lat = parseCoordinate(at[1]);
    const lon = parseCoordinate(at[2]);
    if (isUsableCoordinate(lat, lon)) return { lat, lon, source: 'map url @lat,lon' };
  }

  return null;
}

/**
 * @param {Document} doc
 */
export function extractFromMapLinks(doc) {
  const nodes = doc.querySelectorAll('a[href], img[src], iframe[src]');
  let visited = 0;
  const candidates = [];

  for (const node of nodes) {
    if (visited >= MAX_ELEMENTS) break;
    visited += 1;
    const raw = node.getAttribute('href') || node.getAttribute('src');
    if (!raw || raw.length > MAX_URL_CHARS) continue;
    // Cheap pre-filter: only URLs that look map-ish are worth parsing. Without it a page with
    // thousands of links makes this the slowest thing on the page.
    if (!/map|maps|geo|marker|\bll=|@-?\d/i.test(raw)) continue;

    const hit = readUrl(raw);
    if (hit == null) continue;

    // Compare ONLINE, and never stop early on agreement. Collecting the first eight and checking
    // them afterwards meant a page could place eight identical advert maps ahead of the listing's
    // own map: the scan stopped satisfied, the real map was never seen, and the unrelated location
    // was returned with confidence. Stopping early on agreement is only safe if you have already
    // seen everything, which is the thing stopping early prevents.
    // (Codex review round 12, PR #1.)
    if (candidates.length > 0 && distanceMetres(candidates[0], hit) > CONFLICT_METRES) {
      return ambiguous('map urls disagreed about the location');
    }
    candidates.push(hit);
  }

  if (candidates.length === 0) {
    return notFound(visited === 0 ? 'no elements to examine' : 'no map url carried a usable coordinate');
  }

  // Every candidate on the page agreed. Taking the first map-shaped URL in document order used to
  // assume the listing's own map comes first, which nothing enforces — a city-overview map, a
  // "hotels near here" widget or an advert can appear earlier. A confident wrong coordinate is worse
  // than no coordinate: tier 3 or an honest failure both beat pinning a gym next to a hotel the
  // person is not looking at. (Codex review round 11, PR #1.)
  const first = candidates[0];

  return found({
    lat: first.lat,
    lon: first.lon,
    tier: 2,
    source: first.source,
    // A map pin is drawn where the site wants it shown. On a site that fuzzes location by design the
    // pin is the centre of the fuzzed area, so this tier is never building-accurate.
    precision: 'approximate',
  });
}
