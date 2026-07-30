// Tier 2 — coordinates embedded in map links and static map images.
//
// Nearly every listing page has a map on it. For the pin to land in the right place the position
// has to be present in the link or image URL, so it is sitting in plain sight. Stable for the same
// reason as Tier 1: the site needs it correct for their own feature to work.
//
// SECURITY: these are attacker-supplied URLs read from the page. We parse them with the URL API
// rather than by hand, we never navigate to them, and we never send them anywhere.

import { found, notFound } from './result.js';
import { isUsableCoordinate, parseCoordinate } from '../lib/geo.js';

const MAX_ELEMENTS = 400;

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
  let examined = 0;

  for (const node of nodes) {
    if (examined >= MAX_ELEMENTS) break;
    const raw = node.getAttribute('href') || node.getAttribute('src');
    if (!raw) continue;
    // Cheap pre-filter: only URLs that look map-ish are worth parsing. Without it a page with
    // thousands of links makes this the slowest thing on the page.
    if (!/map|maps|geo|marker|\bll=|@-?\d/i.test(raw)) continue;
    examined += 1;

    const hit = readUrl(raw);
    if (hit != null) {
      return found({
        lat: hit.lat,
        lon: hit.lon,
        tier: 2,
        source: hit.source,
        // A map pin is drawn where the site wants it shown. On a site that fuzzes location by
        // design, the pin is the centre of the fuzzed area — so this tier can never be assumed
        // building-accurate.
        precision: 'approximate',
      });
    }
  }

  return notFound(examined === 0 ? 'no map-shaped urls on page' : 'map urls carried no usable coordinate');
}
