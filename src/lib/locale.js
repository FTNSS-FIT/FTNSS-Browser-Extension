// Which language version of FTNSS a link should open.
//
// ENGLISH ONLY TODAY, and the structure exists anyway because the alternative is worse. FTNSS
// serves 31 locales with `localePrefix: 'always'`, so EVERY url carries one — there is no
// unprefixed form to fall back to. That means a link cannot be built without choosing a locale, and
// code that "just uses /en" has made the choice without admitting it. Naming the choice now costs
// one small module; retrofitting it means finding every place a url was assembled.
//
// The rule this encodes: a locale we cannot verify is supported is not used. A wrong prefix does
// not degrade gracefully — it 404s, and it does so on the one click where someone was actually
// trying to reach us.

/**
 * The locales FTNSS serves, from the site's own `src/i18n/config.ts`.
 *
 * A COPY, and knowingly a liability: two lists that must agree eventually will not. It is here
 * rather than fetched because a link has to be built synchronously while rendering, and because the
 * failure mode of a stale copy is bounded — we would omit a language we now support, not send
 * someone to a page that does not exist. That asymmetry is the whole reason for an allowlist.
 */
export const SUPPORTED_LOCALES = Object.freeze([
  'en', 'es', 'fr', 'fr-CA', 'de', 'pt', 'it', 'nl', 'pl', 'sv', 'da',
  'ar', 'he', 'ur', 'fa',
  'zh', 'ja', 'ko',
  'hi', 'bn', 'ta', 'tl',
  'tr', 'ru', 'uk', 'el',
  'th', 'vi', 'id', 'ms',
  'sw',
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

  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return null;
  }
  return `${origin}/${locale}${path}`;
}
