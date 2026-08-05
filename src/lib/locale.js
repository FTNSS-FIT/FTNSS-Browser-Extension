// Which language version of FTNSS a link should open.
//
// ENGLISH ONLY TODAY, and the structure exists anyway because the alternative is worse. FTNSS
// serves 31 locales with `localePrefix: 'always'`, so EVERY url carries one — there is no
// unprefixed form to fall back to. That means a link cannot be built without choosing a locale, and
// code that "just uses /en" has made the choice without admitting it. Naming the choice now costs
// one small module; retrofitting it means finding every place a url was assembled.
//
// The rule this encodes: a locale we cannot verify is supported is not used. And the failure is
// worse than a plain 404 — an unrecognised prefix gets ANOTHER prefix bolted on by the site's
// middleware:
//
//     /xx/book/gyms/…  →  307  →  /en/xx/book/gyms/…  →  404
//
// Consumer Web hit exactly this shape recently: `zh-Hant` was not recognised as a locale, so
// `/zh-Hant/r/CODE` became `/en/zh-Hant/r/CODE` and 404'd, silently losing referral attribution.
// The dangerous part is not the 404 — it is that the wreckage looks plausible in a log.

/**
 * The locales FTNSS serves, from the site's own `src/i18n/config.ts`.
 *
 * A COPY, and knowingly a liability: two lists that must agree eventually will not. It is here
 * rather than fetched because a link has to be built synchronously while rendering, and because the
 * failure mode of a stale copy is bounded — we would omit a language we now support, not send
 * someone to a page that does not exist. That asymmetry is the whole reason for an allowlist.
 *
 * THIS LIST WAS WRONG ON ITS FIRST WRITING — 31 entries instead of 57, because it was read from a
 * truncated view of the source file that happened to end on a complete-looking line. Caught by
 * Consumer Web, who noticed the arithmetic: the live sitemap has 1824 urls, and 1824 / 57 = 32
 * paths exactly. It is now extracted from `origin/main` mechanically rather than transcribed, and
 * the count is asserted in the tests so a future truncation fails loudly.
 */
export const SUPPORTED_LOCALES = Object.freeze([
  'en', 'es', 'fr', 'fr-CA', 'de', 'pt', 'it', 'nl', 'pl', 'sv', 'da', 'ar', 'he', 'ur', 'fa',
  'zh', 'ja', 'ko', 'hi', 'bn', 'ta', 'tl', 'tr', 'ru', 'uk', 'el', 'th', 'vi', 'id', 'ms', 'sw',
  'nb', 'fi', 'cs', 'sk', 'sl', 'hu', 'ro', 'bg', 'hr', 'et', 'lv', 'lt', 'ca', 'sr', 'ga', 'mt',
  'en-GB', 'en-CA', 'en-AU', 'es-MX', 'pt-PT', 'pa', 'te', 'mr', 'gu', 'zh-Hant'
]);

export const DEFAULT_LOCALE = 'en';

/**
 * What this build will actually use.
 *
 * Deliberately NOT the browser's language yet. `chrome.i18n.getUILanguage()` is available and it
 * would be one line — but shipping it untested would mean a German browser silently getting `/de`
 * pages nobody here has looked at, and the panel is the extension's first user-facing surface.
 * English until the translated pages have been checked; the plumbing below is what makes that a
 * one-line change rather than a refactor.
 */
export function activeLocale() {
  return DEFAULT_LOCALE;
}

/**
 * Turn a site-relative path into a URL on the FTNSS origin we are already talking to.
 *
 * THE PATH COMES FROM THE SERVER AND IS TREATED AS HOSTILE. It arrives over the network, and this
 * is a public repo whose endpoint anyone can repoint by editing one setting — so a server-supplied
 * link is an open-redirect waiting to happen. A page that can make the panel render
 * `https://not-ftnss.example/login` has a phishing surface handed to it by the one part of the
 * extension a user is meant to trust.
 *
 * So the origin is OURS — taken from the endpoint being called, never from the response — and the
 * path must be a plain site-relative path under the gym directory. Anything else returns null and
 * the panel renders no link at all, which is the correct failure: a gym with no link is a minor
 * loss, and a gym with the wrong link is the whole problem.
 *
 * @param {string} path      site-relative, no locale prefix, e.g. `/book/gyms/ca/ontario/…`
 * @param {string} endpoint  the proximity endpoint, used only for its origin
 */
/**
 * The FTNSS sites a gym link may point at.
 *
 * Same list as the manifest's `optional_host_permissions`, minus localhost — because a local stub
 * is an endpoint, not a website. Kept here rather than read from the manifest so this stays a pure
 * function usable outside an extension context (tools/check-links.mjs runs it in plain node).
 */
const SITE_ORIGINS = Object.freeze(['https://ftnss.fit', 'https://www.ftnss.fit']);

/**
 * Which site a gym link should open, given the endpoint being called.
 *
 * THE ENDPOINT ORIGIN IS NOT THE SITE ORIGIN, and assuming they were the same shipped a bug that
 * only real use could find: with the endpoint pointed at the local stub, every gym link resolved to
 * `http://localhost:8787/en/book/gyms/…` and the stub answered `{"error":"extension origins only"}`.
 * The link was built correctly and pointed at a machine with no website on it.
 *
 * They coincide in production and diverge everywhere else — which is exactly the shape of thing that
 * passes every test and fails the first time somebody clicks.
 *
 * So: follow the endpoint's origin only when it IS an FTNSS site, and otherwise fall back to
 * production. That keeps the property worth having — the origin is ours, never the response's — and
 * makes a stub behave like a stub: it answers proximity queries, and gym pages still open on the
 * real site.
 */
export function siteOriginFor(endpoint) {
  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return null;
  }
  if (SITE_ORIGINS.includes(origin)) return origin;
  // A staging FTNSS host would be added to SITE_ORIGINS deliberately. Anything else — a stub, a
  // tunnel, a mistake — gets production, because a gym page exists there and nowhere else.
  return SITE_ORIGINS[0];
}

export function gymUrl(path, endpoint, locale = activeLocale()) {
  if (typeof path !== 'string' || typeof endpoint !== 'string') return null;
  if (!SUPPORTED_LOCALES.includes(locale)) return null;

  // A single leading slash, then the gym directory. `//evil.example` is a protocol-relative URL and
  // resolves to a different HOST — it looks like a path and is not one, which is exactly the sort
  // of thing a denylist misses and a strict pattern does not.
  // At least one segment BEYOND the directory. `/book/gyms/` is a real page — the browse index — so
  // it is not dangerous, but a row that names a gym and links to the index is a small lie, and the
  // check costs one character. Deliberately not asserting the FULL four-segment depth: how deep a
  // gym page sits is the site's business, and pinning it here would break every link the day they
  // reorganise, which is the coupling this design exists to avoid.
  if (!/^\/book\/gyms\/[A-Za-z0-9\-/]+$/.test(path)) return null;
  // `//` would be an empty segment, and at the start of a path it is a different HOST entirely.
  // Unreachable given the pattern above rejects a leading `//` before this line — kept because the
  // pattern is the kind of thing that gets loosened one character at a time.
  if (path.includes('//')) return null;

  const origin = siteOriginFor(endpoint);
  if (origin == null) return null;
  return `${origin}/${locale}${path}`;
}
