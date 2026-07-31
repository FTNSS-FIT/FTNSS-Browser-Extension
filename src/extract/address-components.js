// Structured address components from schema.org PostalAddress.
//
// WHY THIS EXISTS, AND WHY IT REPORTS PRESENCE RATHER THAN VALUES.
//
// Booking.com publishes a lodging node with an address and no coordinates — measured across 13 pages.
// So the Booking path needs geocoding, and geocoding collides with the architecture: a hotel's street
// address IS the listing identity, so sending it anywhere gives away exactly what the extension
// promises it cannot know. (docs/DECISIONS.md §13.)
//
// The way out is to geocode COARSELY — postcode and locality, never the street — which lands inside
// the 250m we round to anyway. But that is only possible if those components are actually published
// separately, and scraping a rendered address string cannot tell them apart: "12 Example Street,
// EX1 2AB Exampleton" is one blob unless the page hands us the parts.
//
// schema.org hands us the parts. This reads them.
//
// It returns WHICH components are present, never what they say. That is the whole point: knowing
// "postcode and locality are available on 90% of Booking pages" decides whether coarse geocoding is
// viable, and knowing WHICH postcode would be the leak we are trying to avoid. A measurement that
// requires the thing it is measuring the safety of is not a measurement worth taking.

const ADDRESS_KEYS = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'];

/**
 * Well-known codes that are not ISO 3166-1 alpha-2 but appear constantly in the wild.
 *
 * "UK" is the obvious one, and it was measured on real Booking pages. The United Kingdom's actual
 * code is GB; "UK" is a reserved exception that everyone uses anyway. Passing it to a geocoder
 * unchanged is a lookup that quietly fails, so normalise it here rather than discovering it later.
 */
const ALIASES = { UK: 'GB', EL: 'GR', AN: 'NL', USA: 'US', UAE: 'AE' };

/**
 * Country NAMES to codes.
 *
 * Measured need: Booking publishes `addressCountry` on 100% of pages, and a code on roughly a
 * quarter of them — the rest are names. Reading only codes meant discarding a component that was
 * there all along and reporting it as absent, which is the difference between "coarse geocoding is
 * viable" and "coarse geocoding is impossible" on the site that needs it.
 *
 * A FIXED TABLE, deliberately. The input is page-controlled text, so nothing arbitrary may pass
 * through: a name is looked up and only ever emitted as a code we already knew about. An unknown
 * name yields null and is reported as unparsed, which keeps the "our bug or their absence"
 * distinction honest as the table grows.
 */
const NAMES = {
  'united states': 'US', 'united states of america': 'US', 'u.s.a.': 'US', 'u.s.': 'US',
  canada: 'CA', mexico: 'MX', brazil: 'BR', 'brasil': 'BR', argentina: 'AR', chile: 'CL',
  'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'northern ireland': 'GB', ireland: 'IE',
  portugal: 'PT', spain: 'ES', 'españa': 'ES', france: 'FR', germany: 'DE', deutschland: 'DE',
  italy: 'IT', italia: 'IT', netherlands: 'NL', 'the netherlands': 'NL', belgium: 'BE',
  switzerland: 'CH', austria: 'AT', denmark: 'DK', sweden: 'SE', norway: 'NO', finland: 'FI',
  poland: 'PL', greece: 'GR', 'czech republic': 'CZ', czechia: 'CZ', croatia: 'HR',
  australia: 'AU', 'new zealand': 'NZ', japan: 'JP', 'south korea': 'KR', china: 'CN',
  india: 'IN', thailand: 'TH', singapore: 'SG', 'united arab emirates': 'AE',
  'south africa': 'ZA', morocco: 'MA', turkey: 'TR', 'türkiye': 'TR',
};

/** ISO 3166-1 alpha-2, or null. Codes only — never a country NAME, which is page-controlled text. */
function countryCode(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const upper = trimmed.toUpperCase();
    if (ALIASES[upper]) return ALIASES[upper];
    if (/^[A-Z]{2}$/.test(upper)) return upper;
    // A name, looked up in a fixed table. Nothing arbitrary passes through: an unknown name yields
    // null and is reported as unparsed rather than carried.
    return NAMES[trimmed.toLowerCase()] ?? null;
  }
  // schema.org allows a nested Country object.
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return countryCode(value.name ?? value.identifier);
  }
  return null;
}

const present = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Did the page publish a country AT ALL?
 *
 * Separate from `countryCode` because the two answer different questions — this one is about the
 * SITE, that one is about our parser — and separate from a bare `!= null` because that is what it
 * used to be and it let `addressCountry: {}` through. A postcode plus an empty object was reported
 * as a published country, which after the tier-1 change was enough to promote a page to
 * `found_address`. Every byte here is page-controlled; "not null" is not a validation.
 *
 * schema.org allows a nested `Country`, so an object counts — but only if it actually carries a
 * name or identifier worth the word "published".
 */
function countryIsPublished(value) {
  if (present(value)) return true;
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return present(value.name) || present(value.identifier);
  }
  return false;
}

/**
 * A local, never-exported reading of what an address SAYS.
 *
 * The presence map cannot tell two hotels apart: a Lisbon listing and a Tokyo listing both have a
 * street, a locality, a postcode and a country, so intersecting them yields a complete-looking
 * address describing neither. The coordinate path fails closed when a page describes two places;
 * this is what lets the address path do the same.
 *
 * STRUCTURED FIELDS, not a joined string. A single fingerprint could not express "these two agree
 * on everything they both state", and it silently dropped whatever it did not concatenate — the
 * first version omitted the region, so Springfield, Illinois and Springfield, Massachusetts with no
 * postcode compared equal and merged into one address. (Codex, PR #10.)
 *
 * Values never leave this module: they are compared and discarded. Fields are truncated because the
 * input is page-controlled and unbounded, and a comparison does not need the tail.
 */
export function addressValuesOf(node) {
  const address = node?.address;
  if (address == null || typeof address !== 'object' || Array.isArray(address)) return null;
  // NOT TRUNCATED. An earlier version capped each field at 120 characters before comparing, so two
  // addresses agreeing on their first 120 characters and diverging after were merged into one. The
  // cap was there to bound page-controlled input, and it is not needed for that: tier 1 refuses any
  // ld+json block over MAX_JSON_CHARS before parsing it, so every value here is already bounded.
  // A bound that turns a difference into a match is not a safety measure. (Codex, PR #10.)
  const part = (value) => {
    if (typeof value === 'string') return value.trim().toLowerCase().replace(/\s+/g, ' ');
    // A NESTED OBJECT IS NOT AN EMPTY FIELD. schema.org allows `addressCountry: {name: "Hungary"}`,
    // and returning '' for it made Hungary and Romania compare EQUAL — both unknown, therefore
    // compatible, therefore one valid address. The country is where this costs most: a geocoder
    // aimed at the wrong country returns nothing, or somewhere confidently wrong.
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      return part(value.name ?? value.identifier);
    }
    return '';
  };
  const values = {
    street: part(address.streetAddress),
    locality: part(address.addressLocality),
    region: part(address.addressRegion),
    postalCode: part(address.postalCode),
    // The code when we recognise it, so "GB" and "United Kingdom" are one country rather than two.
    // The raw name when we do not, so two countries we cannot name are still two countries.
    country: countryCode(address.addressCountry) ?? part(address.addressCountry),
  };
  return Object.values(values).some((v) => v.length > 0) ? values : null;
}

/**
 * Could these two be the same place?
 *
 * UNKNOWN IS COMPATIBLE, and that is the whole design. Requiring equality treated a page that
 * publishes its listing twice at different levels of detail — extremely common — as a page
 * describing two places, which fails closed on the ordinary case and measures nothing. A field
 * conflicts only when BOTH sides state something and the statements differ.
 *
 * Formatting still counts as a difference: "1 Main Street" and "1 Main St" conflict. That is
 * deliberate and it is cheap, because a conflict no longer discards a coordinate — see the runner
 * in tier1-structured-data.js.
 */
export function addressesCompatible(a, b) {
  if (a == null || b == null) return true;
  return Object.keys(a).every((key) => {
    const left = a[key];
    const right = b[key];
    return left === '' || right === '' || left === right;
  });
}

/** Fill in what the other side knew. Neither overwrites the other; they have already agreed. */
export function mergeAddressValues(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const out = {};
  for (const key of Object.keys(a)) out[key] = a[key] || b[key];
  return out;
}

/**
 * Reduce a PostalAddress to a presence map plus a country code.
 *
 * The country is the one value carried rather than a flag, and it is worth being explicit about
 * why: coarse geocoding behaves completely differently by country — a UK or Dutch postcode resolves
 * to a building, a US ZIP to several square kilometres — so "can we geocode coarsely" is
 * unanswerable without it. It is also coarser than the 250m coordinate already stored for pages
 * that have one, so it widens nothing that is not already accepted.
 */
export function addressComponentsOf(node) {
  const address = node?.address;
  if (address == null || typeof address !== 'object' || Array.isArray(address)) return null;

  // PRESENT-BUT-UNPARSED IS NOT ABSENT.
  //
  // The first Booking measurements came back with `country: null` on 24 of 27 pages, and there was
  // no way to tell whether Booking omits the country or publishes it in a form this function
  // refuses — which are opposite findings, one about the site and one about us. Exactly the
  // distinction that was made a virtue of for coordinates, and then not made here.
  const rawCountry = address.addressCountry;
  const components = {
    street: present(address.streetAddress),
    locality: present(address.addressLocality),
    region: present(address.addressRegion),
    postalCode: present(address.postalCode),
    // THREE STATES, NOT TWO. Published-and-usable, published-but-unreadable, and absent.
    //
    // Collapsing the first two overstated geocoding viability: a country we cannot turn into a code
    // is no more use to a geocoder than one that was never published, but it looked identical in
    // the report. "Ruritania" counted as viable.
    countryPublished: countryIsPublished(rawCountry),
    countryParsed: countryCode(rawCountry) != null,
    // The code itself is NOT carried into records — see storage.js. It answered its question.
    country: countryCode(rawCountry),
  };

  // Nothing usable is not the same as no address object at all, but for our purposes it is: a
  // PostalAddress with every field empty tells us as little as its absence.
  if (!ADDRESS_KEYS.some((key) => present(address[key]) || (key === 'addressCountry' && components.country))) {
    return null;
  }
  return components;
}

/**
 * Does this describe a PLACE, as opposed to a fragment of one?
 *
 * The threshold for reporting `found_address` at all, and deliberately looser than
 * `coarselyGeocodable` below — that one asks whether we can geocode without the street, this one
 * asks whether there is an address here worth geocoding by any means. A country plus either a
 * postcode or a locality is the least that resolves anywhere; a bare street or a lone region is a
 * component, not a location.
 *
 * `countryPublished` rather than `countryParsed`: a country we failed to turn into a code is still
 * a country the SITE published, and conflating those is how a parser gap gets written down as a
 * finding about a market. (The same distinction the country table exists to keep honest.)
 */
export function describesAPlace(components) {
  if (components == null) return false;
  if (!components.countryPublished) return false;
  // TWO COMPONENTS PLUS A COUNTRY. Any single one of them describes an area, not a listing:
  //
  //   locality alone   "Lisbon, Portugal"  — a city; geocodes to the city centre
  //   postcode alone   "90210, US"         — several square kilometres, wider than the whole
  //                                          search radius the panel talks about
  //   street alone     "1 Oak St"          — there are thousands
  //
  // Both of the first two were accepted in turn during this PR, and both would have been counted in
  // the report as an address we could locate. A wrong answer that looks like a success is the
  // failure mode this project cares about most, and postcode-only is the one that would have looked
  // fine in the UK and been useless across the entire US market.
  //
  // Any two of the three pins a building well enough to be worth geocoding. Note this is the bar for
  // calling the read a SUCCESS; whether the street may leave the browser to geocode it is a
  // different question, and a stricter one. (docs/DECISIONS.md 13.)
  const stated = [components.street, components.locality, components.postalCode].filter(Boolean);
  return stated.length >= 2;
}

/**
 * Could this address be geocoded WITHOUT sending the street?
 *
 * Postcode plus country is the minimum that resolves anywhere; locality alone is ambiguous in most
 * countries and useless in some. This is the question the whole geocoding decision turns on, and it
 * is answerable from presence alone.
 */
export function coarselyGeocodable(components) {
  if (components == null) return false;
  return Boolean(components.postalCode && components.country);
}
