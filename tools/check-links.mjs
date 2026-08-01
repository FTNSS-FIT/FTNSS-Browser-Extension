// Do the links this extension builds actually resolve?
//
// NOT part of `npm test`, deliberately: it needs the network and a live site, and a unit suite that
// silently depends on production is a suite that fails for reasons unrelated to the change in front
// of you. Run it by hand, or on a schedule, when you want to know whether the world still matches
// what the code assumes.
//
//   node tools/check-links.mjs                    # every gym in the local fixture
//   node tools/check-links.mjs --locales          # one gym under all 57 locales
//
// WHY IT EXISTS. Every url this extension emits is assembled from three assumptions it does not
// own: that the gym path shape is `/book/gyms/{country}/{state}/{city}/{slug}`, that the segments
// are the same in every language, and that each locale prefix is really served. All three were
// verified once, by hand, against production. A verification you ran once protects you until the
// next deploy on somebody else's repo — and the failure is silent, because a 404 on a link nobody
// clicked looks exactly like a link nobody clicked. (Consumer Web's suggestion; they run the same
// idea over their sitemap.)
//
// A redirect counts as a FAILURE, not a pass. `/xx/book/gyms/…` answers 307 and lands on
// `/en/xx/book/gyms/…`, which 404s — so following redirects would turn the exact bug this guards
// against into a green tick.

import { readFileSync } from 'node:fs';
import { gymUrl, SUPPORTED_LOCALES, activeLocale } from '../src/lib/locale.js';

const ENDPOINT = process.env.FTNSS_ENDPOINT ?? 'https://ftnss.fit/api/proximity';
const CONCURRENCY = 4;

/**
 * Build the path the way the site does, from Consumer Web's `createSlug`:
 * NFD-normalise, strip diacritics, lowercase, strip non-word, collapse to hyphens.
 *
 * `country` is stored as a CODE (`CA`, `US`) and lowercases to `ca`, `us` — not the country name.
 * `slug` is used VERBATIM from the row; re-slugging it is how you quietly break the awkward ones.
 */
const createSlug = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

function fixture() {
  try {
    return JSON.parse(readFileSync(new URL('./proximity-fixture.json', import.meta.url), 'utf8'));
  } catch {
    console.error('no tools/proximity-fixture.json — nothing to check against');
    process.exit(2);
  }
}

const pathFor = (gym) =>
  `/book/gyms/${createSlug(gym.countrySlug ?? gym.country ?? 'us')}` +
  `/${createSlug(gym.stateSlug ?? gym.state)}` +
  `/${createSlug(gym.citySlug ?? gym.city)}` +
  `/${gym.slug}`;

async function check(url) {
  try {
    // `manual` so a redirect is reported rather than followed — see the note above.
    const response = await fetch(url, { method: 'GET', redirect: 'manual' });
    return { url, status: response.status, ok: response.status === 200 };
  } catch (err) {
    return { url, status: err?.message ?? 'network error', ok: false };
  }
}

async function run(urls) {
  const results = [];
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        results.push(await check(next));
      }
    }),
  );
  return results;
}

const gyms = fixture();
const everyLocale = process.argv.includes('--locales');

const urls = everyLocale
  ? SUPPORTED_LOCALES.map((locale) => gymUrl(pathFor(gyms[0]), ENDPOINT, locale))
  : gyms.map((gym) => gymUrl(pathFor(gym), ENDPOINT));

const unbuildable = urls.filter((url) => url == null).length;
if (unbuildable > 0) {
  console.error(`${unbuildable} url(s) could not be built at all — the validator refused them`);
}

const results = await run(urls.filter(Boolean));
const failures = results.filter((r) => !r.ok);

for (const failure of failures) console.error(`  ${failure.status}  ${failure.url}`);
console.log(
  `${results.length - failures.length}/${results.length} resolved 200` +
  (everyLocale ? ` (one gym across ${SUPPORTED_LOCALES.length} locales)` : ` (locale: ${activeLocale()})`),
);

process.exit(failures.length > 0 || unbuildable > 0 ? 1 : 0);
