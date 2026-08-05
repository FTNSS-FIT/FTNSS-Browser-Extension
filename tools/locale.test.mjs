// Link building. The panel is the part of this extension a person is meant to trust, so a
// server-supplied path becoming a link is the one place a compromised or repointed endpoint could
// do real harm — these tests are mostly about what must NOT become a link.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gymUrl, activeLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../src/lib/locale.js';

const ENDPOINT = 'https://ftnss.fit/api/proximity';
const PATH = '/book/gyms/ca/ontario/toronto/hone-fitness-isabella-toronto';

test('a gym path becomes a locale-prefixed url on the endpoint origin', () => {
  // Verified against production: this exact shape returns 200 and every url carries a locale
  // prefix, including English — `localePrefix: 'always'`, so there is no unprefixed form.
  assert.equal(gymUrl(PATH, ENDPOINT), `https://ftnss.fit/en${PATH}`);
});

test('a link opens the SITE, not whatever host serves the endpoint', () => {
  // This asserted that links follow the endpoint's origin, and real use found the flaw: with the
  // endpoint pointed at the local stub, every gym link resolved to
  // http://localhost:8787/en/book/gyms/… and the stub answered `extension origins only`. The link
  // was built correctly and pointed at a machine with no website on it.
  //
  // Endpoint origin and site origin coincide in production and diverge everywhere else — the shape
  // of thing that passes every test and fails the first time somebody clicks.
  assert.equal(gymUrl(PATH, 'http://localhost:8787/api/proximity'), `https://ftnss.fit/en${PATH}`);
  assert.equal(gymUrl(PATH, 'https://not-ftnss.example/api/proximity'), `https://ftnss.fit/en${PATH}`);

  // An FTNSS host IS followed, so a real second origin still works.
  assert.equal(gymUrl(PATH, 'https://www.ftnss.fit/api/proximity'), `https://www.ftnss.fit/en${PATH}`);

  // The property that mattered is untouched: the origin is ours, and no response can choose it.
  assert.equal(gymUrl(PATH, ENDPOINT), `https://ftnss.fit/en${PATH}`);
});

test('nothing that is not a site-relative gym path becomes a link', () => {
  for (const hostile of [
    'https://not-ftnss.example/login',            // absolute url
    '//not-ftnss.example/login',                  // protocol-relative: looks like a path, changes host
    '/book/gyms/../../admin',                     // traversal
    '/book/gyms//not-ftnss.example',              // embedded authority
    'javascript:alert(1)',                        // scheme
    '/account/settings',                          // real site, wrong place
    '/book/gyms/<script>',                        // markup
    '/book/gyms/',                                // the browse index — real, but not this gym
    '/book/gyms/ca?next=https://evil.example',    // query
    '/book/gyms/ca#@evil.example',                // fragment
    '/book/gyms/%2e%2e/%2e%2e/admin',             // encoded traversal
    '/book/gyms/ca@evil.example',                 // userinfo-shaped
    ' /book/gyms/ca/on/to/x',                     // leading space
    '/BOOK/GYMS/ca/on/to/x',                      // wrong route, right shape
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(gymUrl(hostile, ENDPOINT), null, `${String(hostile)} must not become a link`);
  }
});

test('an unsupported locale produces no link rather than a 404', () => {
  // A wrong prefix does not degrade — it 404s, on the one click where someone was trying to reach
  // us. An allowlist fails by omitting a language we do support, which is the survivable direction.
  assert.equal(gymUrl(PATH, ENDPOINT, 'xx'), null);
  assert.equal(gymUrl(PATH, ENDPOINT, 'en-US'), null, 'close is not the same as supported');
  assert.equal(gymUrl(PATH, ENDPOINT, 'fr-CA'), `https://ftnss.fit/fr-CA${PATH}`);
});

test('a malformed endpoint yields no link', () => {
  assert.equal(gymUrl(PATH, 'not a url'), null);
});

test('a hostile path is still refused whatever the endpoint', () => {
  // The site-origin fallback must not become a way to smuggle a path — the path checks run first
  // and independently.
  assert.equal(gymUrl('//evil.example/login', 'http://localhost:8787/api/proximity'), null);
  assert.equal(gymUrl('https://evil.example', 'https://ftnss.fit/api/proximity'), null);
});

test('this build is English, and the plumbing for more is real', () => {
  // English until the translated pages have been checked. The list is what makes switching a
  // one-line change rather than a refactor.
  assert.equal(activeLocale(), 'en');
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.ok(SUPPORTED_LOCALES.includes('fr-CA') && SUPPORTED_LOCALES.includes('ja'));
  // 57, and it was written as 31 first — read from a truncated view of the source that ended on a
  // complete-looking line. Asserted precisely so the next truncation fails loudly rather than
  // quietly withholding links from 26 languages.
  assert.equal(SUPPORTED_LOCALES.length, 57, 'kept in step with the site config');
  for (const late of ['nb', 'zh-Hant', 'en-GB', 'es-MX', 'pt-PT', 'mt', 'gu']) {
    assert.ok(SUPPORTED_LOCALES.includes(late), `${late} is served and must be linkable`);
  }
  assert.throws(() => SUPPORTED_LOCALES.push('zz'), 'the list must not be mutable at runtime');
});
