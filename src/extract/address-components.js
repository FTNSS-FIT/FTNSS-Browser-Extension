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
    countryPublished: rawCountry != null && rawCountry !== '',
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
