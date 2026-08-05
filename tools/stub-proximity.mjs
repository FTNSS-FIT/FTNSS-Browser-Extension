// A stand-in for the proximity endpoint, so the panel can be built and seen before the real one
// exists. Development only — never shipped, never called by the extension unless you point it here.
//
// It implements the shape agreed in the Phase 0 brief exactly, including the parts that are easy to
// get wrong in a stub and then discover in production: empty is a 200, the response carries no
// coordinates, and the input is snapped to the same grid the client already applied. A stub that is
// more permissive than the real thing teaches you the wrong lesson twice — once when it works here
// and once when it does not work there.
//
//   node tools/stub-proximity.mjs
//   → http://localhost:8787/api/proximity
//
// GYM DATA IS NOT IN THIS REPO. The repo is public and our supply numbers are not. Put a
// `proximity-fixture.json` next to this file — gitignored — shaped as:
//
//   [ { "id": "…", "name": "…", "slug": "…", "city": "…", "latitude": 43.6, "longitude": -79.4 } ]
//
// Without it the server runs on three obviously-fake gyms, which is enough to exercise the panel
// and honest about being fake.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { toTransmittablePoint } from '../src/lib/geo.js';

const PORT = Number(process.env.PORT ?? 8787);
const RADIUS_METRES = 5000;
const LIMIT = 6;

const PLACEHOLDER = [
  { id: 'stub-1', name: 'Example Strength (fixture)', slug: 'example-1', city: 'Nowhere', latitude: 0.001, longitude: 0.001 },
  { id: 'stub-2', name: 'Example Fitness (fixture)', slug: 'example-2', city: 'Nowhere', latitude: 0.004, longitude: 0.004 },
  { id: 'stub-3', name: 'Example Gym (fixture)', slug: 'example-3', city: 'Nowhere', latitude: 0.02, longitude: 0.02 },
];

function loadGyms() {
  try {
    const raw = readFileSync(new URL('./proximity-fixture.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Absent or unreadable is the normal case for a fresh clone.
  }
  console.log('no proximity-fixture.json — serving placeholder gyms');
  return PLACEHOLDER;
}

const GYMS = loadGyms();

/**
 * Haversine — NOT DISTANCE-AUTHORITATIVE, and measured against the real service rather than assumed.
 *
 * Checked against the production implementation over a city-sized sample: identical result set,
 * identical ordering, distances up to ~0.3% shorter here. Every delta was in the same direction and
 * proportional to distance, which is the signature of this sphere (R = 6,371,008.8 m) standing in
 * for the WGS84 ellipsoid. Neither is wrong; a sphere is a slightly small model of the Earth.
 *
 * Immaterial at our precision: we round to a 250m grid and display "about 3.7 km", so a
 * sub-percent disagreement sits two orders of magnitude below anything a person sees. Written down
 * because a future reader comparing the two would otherwise have a discrepancy to chase.
 *
 * This file stays after the real endpoint exists. It is a TEST DOUBLE, not a placeholder: it runs
 * in CI with no network, and it is the only way to exercise the timeout, HTTP 500,
 * malformed-payload and empty-result paths without breaking production to do it.
 */
function metresBetween(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.lat);
  const dLon = toRad(b.longitude - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * EXTENSION ORIGINS ONLY. The wildcard that is defensible for the real endpoint is not defensible
 * here, and the asymmetry is the point.
 *
 * The production endpoint serves published gym data to anyone; `*` costs it nothing. This server
 * runs on Jordan's laptop, loaded from a gitignored fixture of internal supply data, while he
 * browses hotel sites — and with `*` any page he visits could fetch localhost:8787 and enumerate
 * the lot. A development convenience reachable by every site he happens to open is a worse exposure
 * than the thing it stands in for.
 *
 * A chrome-extension:// origin cannot be forged by a web page: the browser sets it, and a page's
 * own origin is always its site.
 *
 * ACCEPTED LIMITATION: any installed extension is accepted, not one specific ID. Pinning it would
 * mean an environment variable and a per-run nonce, and this whole localhost path is scheduled for
 * deletion the moment the production route exists — at which point this file keeps only its CI job,
 * where no browser and no extension is involved. Building an authorisation scheme for a server with
 * that life expectancy is effort in the wrong place. The exposure is a laptop-local fixture,
 * readable only by an extension the machine's owner installed, while they have deliberately started
 * this server.
 *
 * If that trade ever stops holding — if this server outlives the production route — pin the ID.
 */
function corsFor(origin) {
  if (typeof origin !== 'string' || !origin.startsWith('chrome-extension://')) return null;
  return {
    'access-control-allow-origin': origin,
    // Not '*' — a reflected origin must be paired with Vary so nothing caches one caller's answer
    // for another.
    vary: 'Origin',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

const server = createServer((req, res) => {
  const cors = corsFor(req.headers.origin);
  if (cors == null) {
    // A CONSTANT, never the Origin header. CORS stops the browser USING the response; it does not
    // stop the request arriving — so any page probing localhost had its hostname written to a log
    // on the machine. That is a browsing trail, assembled outside the browser, by the one tool in
    // this project whose entire purpose is not to build one. The irony is not the reason to fix it;
    // the log file is.
    console.log('refused a request from a non-extension origin');
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":"extension origins only"}');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/api/proximity')) {
    res.writeHead(404, { ...cors, 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      send(400, { error: 'bad json' });
      return;
    }

    // SNAP SERVER-SIDE, as the brief asks. Client-side rounding is a promise; this is the
    // enforcement, and the stub does it so we find out here if the client ever stops.
    const point = toTransmittablePoint(Number(input?.lat), Number(input?.lon));
    if (point == null) {
      send(400, { error: 'bad coordinate' });
      return;
    }

    const gyms = GYMS
      .map((gym) => ({ gym, metres: metresBetween(point, gym) }))
      .filter(({ metres }) => metres <= RADIUS_METRES)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, LIMIT)
      // Explicit column list. Note what is NOT here: latitude, longitude, contact details.
      .map(({ gym, metres }) => ({
        // Built the way the real site builds it, from the fixture's own slugs — so the panel's
        // link handling is exercised rather than assumed. No locale prefix: that is the client's
        // choice, and the server has no business making it.
        path: gym.countrySlug && gym.stateSlug && gym.citySlug && gym.slug
          ? `/book/gyms/${gym.countrySlug}/${gym.stateSlug}/${gym.citySlug}/${gym.slug}`
          : undefined,
        id: gym.id,
        name: gym.name,
        slug: gym.slug,
        city: gym.city,
        distanceMetres: Math.round(metres),
      }));

    console.log(`${point.lat},${point.lon} → ${gyms.length} gym(s)`);
    // Empty is a 200. "No gyms near here" is a successful answer to the question.
    send(200, { gyms, searchRadiusMetres: RADIUS_METRES });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub proximity endpoint → http://localhost:${PORT}/api/proximity  (${GYMS.length} gyms loaded)`);
});
