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
// separately, and scraping a rendered address string cannot tell them apart: "27 Travessa das
// Merceeiras, 1100-348 Lisboa" is one blob unless the page hands us the parts.
//
// schema.org hands us the parts. This reads them.
//
// It returns WHICH components are present, never what they say. That is the whole point: knowing
// "postcode and locality are available on 90% of Booking pages" decides whether coarse geocoding is
// viable, and knowing WHICH postcode would be the leak we are trying to avoid. A measurement that
// requires the thing it is measuring the safety of is not a measurement worth taking.

const ADDRESS_KEYS = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'];

/** A country code, if it is one. Two letters, uppercased — anything else is discarded. */
function countryCode(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
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

  const components = {
    street: present(address.streetAddress),
    locality: present(address.addressLocality),
    region: present(address.addressRegion),
    postalCode: present(address.postalCode),
    country: countryCode(address.addressCountry),
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
