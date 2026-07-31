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
function countryCode(value, depth = 0) {
  // DEPTH-BOUNDED. schema.org allows a nested Country, and following it recursively meant a page
  // could hand us `{name: {name: {name: …}}}` inside a block small enough to pass the size check and
  // blow the stack — taking down the extraction of a page that may have published a perfectly good
  // coordinate in the same node. Two levels is more than the schema needs. (Codex, PR #10.)
  if (depth > 2) return null;
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
    return countryCode(value.name ?? value.identifier, depth + 1);
  }
  return null;
}

const present = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Does this street name a BUILDING, or just a road?
 *
 * "Oxford Street" is a mile long; counting it as an address we could locate inflates exactly the
 * number this phase exists to produce. Two things can rescue it, and both were too loose at first:
 *
 *   A HOUSE NUMBER — but "any digit anywhere" also accepted "5th Avenue", where the digit is part
 *   of the road's own name. Requires a standalone numeric token now.
 *
 *   A POSTCODE — but only where a postcode names a building. That is the same market-by-market fact
 *   the corroboration check already uses, and applying it here too means "Oxford Street, W1D 1BS"
 *   passes (a UK postcode pins the building) while "Oxford Street, 90210" does not (a US ZIP is a
 *   neighbourhood).
 *
 * STILL IMPERFECT, and knowingly: "Route 66" carries a standalone number that is part of the road's
 * name, and no rule distinguishes it from a house number without knowing the country's addressing
 * convention. House numbers lead in the US and trail in most of Europe; Japan numbers blocks rather
 * than streets; named buildings carry no number at all. Recorded in #12 with the census that would
 * settle it, rather than closed with a guess that fails silently by reporting a market unreadable.
 */
function hasNonOrdinalNumber(text) {
  // English ordinals cover the case that motivated this ("5th Avenue", "1st Street"); a street
  // numbered in another language's ordinals is a gap, and a narrower one than refusing every
  // script whose addresses do not put a space around the number.
  for (const match of text.matchAll(/\p{N}+/gu)) {
    const after = text.slice(match.index + match[0].length);
    if (!/^(st|nd|rd|th)\b/i.test(after)) return true;
  }
  return false;
}

function streetNamesABuilding(address) {
  if (!present(address.streetAddress)) return false;
  // A number that is not an ORDINAL. "1 Oak St" qualifies; "5th Avenue" does not, because there the
  // digit is part of the road's own name.
  //
  // Written as narrowly as this on the second attempt. The first required a standalone numeric
  // token, which is a Latin-script assumption: "中山路1号" is No. 1 Zhongshan Road with the number
  // welded between two characters, so the rule quietly reported China as unreadable — the exact
  // silent failure #12 warns about, produced by the fix meant to avoid it.
  if (hasNonOrdinalNumber(address.streetAddress)) return true;
  return postcodeNamesABuilding(countryCode(address.addressCountry), address.postalCode);
}

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
  const part = (value, depth = 0) => {
    if (typeof value === 'string') return value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (depth > 2) return '';
    // A NESTED OBJECT IS NOT AN EMPTY FIELD. schema.org allows `addressCountry: {name: "Hungary"}`,
    // and returning '' for it made Hungary and Romania compare EQUAL — both unknown, therefore
    // compatible, therefore one valid address. The country is where this costs most: a geocoder
    // aimed at the wrong country returns nothing, or somewhere confidently wrong.
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      return part(value.name ?? value.identifier, depth + 1);
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

/**
 * Do these two state something IN COMMON, and contradict nothing?
 *
 * Distinct from `addressesCompatible`, and the distinction is worth being exact about because
 * conflating them reopened a P0. Compatibility asks "could these be the same place" and answers yes
 * when one side says nothing — the right reading when deciding whether two addresses CONFLICT.
 * Overlap asks "is there evidence these ARE the same place", and silence is not evidence.
 *
 * Clustering needs the second. Using compatibility to cluster meant an address-less stub merged
 * into whichever node had an address, which is precisely the "related hotel's address attributed to
 * the listing" failure the candidate census exists to catch.
 *
 * And the evidence has to be BUILDING-LEVEL. Accepting a match on any field let two hotels in the
 * same country overlap on `country` — the broadest fact on the page establishing the narrowest
 * claim. A shared country is a shared market; a shared locality is a shared city; neither is a
 * shared hotel. (Codex, PR #10.)
 */
export function addressesOverlap(a, b) {
  if (a == null || b == null) return false;
  if (!addressesCompatible(a, b)) return false;
  // ONLY A PINNING FIELD ESTABLISHES IDENTITY — the same street, or the same postcode.
  //
  // Checking every field meant two Portuguese hotels overlapped on `country`, so a listing in
  // Lisbon and a related hotel with coordinates merged into one candidate and the attribution guard
  // was bypassed by the broadest fact on the page. A shared country is a shared market. A shared
  // locality is a shared city. Neither is a shared hotel. (Codex, PR #10.)
  // The shared street must NAME A BUILDING. Two hotels on Oxford Street share a road, and merging
  // them let a related hotel's coordinate be reported as the listing's — the same road-versus-
  // building distinction describesAPlace already makes, missing here.
  // A SHARED STREET NEEDS A WITNESS TOO. "1 Main St" is a real address in thousands of towns, and
  // compatibility permits silence — so a Springfield listing and an unrelated "1 Main St" node
  // carrying the only coordinate on the page merged, and that coordinate was reported. The same
  // correction the corroboration check needed one round earlier, in the other place a street was
  // trusted alone.
  if (a.street !== '' && a.street === b.street && hasNonOrdinalNumber(a.street)) {
    // NOT `region`. A region is a state or a county: two hotels at "1 Main St" in different
    // Californian cities share it, and with the locality omitted they merged, so the related
    // hotel's coordinate was shown as the listing's. A witness has to narrow the claim to a
    // building, and only a locality or a building-level postcode does.
    // ONLY A LOCALITY. A postcode was a witness here until round 17, on the strength of the
    // building-precise table — but "building-precise" was always a claim about GEOCODING RESOLUTION,
    // not about uniqueness, and identity needs uniqueness. A Canadian postcode covers one side of a
    // block, perhaps twenty addresses; a Dutch one a short run of houses. Good enough to geocode to,
    // nowhere near good enough to say two nodes are the same hotel.
    if (a.locality !== '' && a.locality === b.locality) return true;
  }
  // A POSTCODE ONLY WHERE A POSTCODE NAMES A BUILDING — the same market caveat that governs it in
  // textCorroboratesAddress and describesAPlace, and it was missing here alone. Two hotels a few
  // streets apart share a US ZIP routinely, so a listing without coordinates merged with a related
  // hotel that had them and the related hotel's location was reported as a successful read.
  // A postcode alone never establishes identity — see above. The remaining routes are a shared @id,
  // a shared point, or a numbered street plus a matching locality.
  return false;
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
    // A STREET IS NOT AUTOMATICALLY A BUILDING. "Oxford Street" is a mile long, and accepting it as
    // an address we could locate inflated exactly the number this phase exists to produce. A house
    // number is what usually distinguishes the two; where a building is named rather than numbered
    // — "The Savoy" — a postcode does the same job. Neither present means we have a road.
    // (Codex, PR #10.)
    streetNamesABuilding: streetNamesABuilding(address),
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
 * Does the address PRINTED ON THE PAGE corroborate the one in the structured data?
 *
 * Both tiers can now answer with an address, and tier 1 won without ever being checked against
 * tier 3 — so a page whose JSON-LD describes a related hotel while the visible text describes the
 * listing recorded a confident successful read of the wrong property. The coordinate tiers have
 * been cross-checked since round 23; this is the same check for addresses. (Codex, PR #10.)
 *
 * DELIBERATELY WEAK, and this is the whole design decision. The two sides are not comparable
 * artifacts: tier 1 has separated components, tier 3 has one rendered blob that may abbreviate,
 * reorder, translate or omit any of them. Demanding they match would make the ordinary case — a
 * site rendering "1 Oak Street" from `streetAddress: "1 Oak St"` — look like a page contradicting
 * itself, and Booking is 48 of our 63 measured pages. Refusing a correct read is a real cost, not
 * a free safety win.
 *
 * So: the rendered text must corroborate the STREET, on word boundaries. A locality cannot — it
 * says which town both hotels are in, which is not evidence they are the same hotel. A postcode can
 * stand in only where a postcode identifies a building, which is a market-by-market fact and not a
 * general one. If the structured data states neither a street nor a postcode there is nothing to
 * check, and that is an absence of evidence rather than a conflict.
 *
 * WATCH THE AMBIGUITY RATE. This bar was raised three times under review, each time on a plausible
 * argument and none of them on a measurement — nobody has counted how often a real page's rendered
 * text and JSON-LD state the same street differently. Over-refusing is the failure this project
 * prefers, because it shows up as an ambiguity rate in the next export where a wrong row shows up
 * as nothing at all. But it IS a cost, and if Booking's ambiguity rate jumps, this is the knob.
 *
 * This is a floor, not a proof of agreement, and it is written to be one.
 */
export function textCorroboratesAddress(values, text) {
  if (values == null || typeof text !== 'string') return true;
  // NEWLINES SURVIVE HERE TOO. Tier 3 preserves block boundaries as newlines and this function
  // collapsed them again on the first line, which made the boundary work upstream invisible — the
  // second place in two files where a blanket whitespace collapse erased the structure the next
  // step depended on.
  const haystack = text.toLowerCase().replace(/[^\S\n]+/g, ' ').trim();
  if (haystack.length === 0) return true;

  const street = typeof values.street === 'string' ? values.street : '';
  const postalCode = typeof values.postalCode === 'string' ? values.postalCode : '';

  // THE STREET IS THE CORROBORATION. A POSTCODE ONLY SOMETIMES IS.
  //
  // Accepting either was too generous in the markets that matter most: two hotels a few streets
  // apart share a US ZIP routinely — it covers several square kilometres — so a "nearby hotels"
  // block validated the wrong structured address on exactly the pages a dense city produces. The
  // postcode is only a building-level fact in the countries where postcodes are building-level, and
  // that is the same market-by-market caveat already recorded in the findings: a UK, Dutch, Irish
  // or Canadian postcode resolves to a building or a handful; a US ZIP to a neighbourhood.
  // A STREET NEEDS A WITNESS. "1 Oak St, Lisbon" and a rendered "1 Oak St, Porto" agreed on the
  // street and described different cities, and the read was recorded as successful. Where the
  // structured data also states a locality or a postcode, one of them must appear too.
  const witnesses = [values.locality, values.postalCode].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
  // THE WITNESS MUST BELONG TO THE SAME ADDRESS. Searching the whole blob let a page carrying
  // "1 Oak St, Porto — popular destinations: Lisbon" corroborate structured data for "1 Oak St,
  // Lisbon": two unrelated fragments assembled into an agreement neither of them states.
  //
  // SEGMENTED, not windowed. The first attempt required the witness within N characters of the
  // street, and there is no N that works — 120 swallowed the destinations list, and small enough to
  // exclude it would refuse an ordinary address with a venue name in front. Distance was never the
  // right question. The right one is whether the two tokens are part of the same run of text, and
  // punctuation answers it: an address contains commas and never contains a dash-then-prose or a
  // colon-then-list.
  for (const segment of haystack.split(SEGMENT_BREAK)) {
    if (!containsWhole(segment, street)) continue;
    if (witnesses.length === 0) return true;
    if (witnesses.some((w) => containsWhole(segment, w))) return true;
  }
  // A POSTCODE ONLY SPEAKS WHEN THE STREET IS SILENT. Where the structured data states a street and
  // the rendered text does not carry it, a matching postcode used to rescue the read — which is
  // corroborating a conflicting street with a value that covers a block. Where no street was
  // published there is nothing to conflict with, and the postcode is the best evidence available.
  if (street.length === 0 && postalCode.length > 0 &&
      postcodeNamesABuilding(values.country, postalCode) &&
      haystack.split(SEGMENT_BREAK).some((seg) => containsWhole(seg, postalCode))) {
    return true;
  }

  // Nothing to check against. Not a conflict — an absence of evidence either way, and inventing a
  // conflict from it would refuse pages for publishing less rather than for disagreeing.
  if (street.length === 0 && postalCode.length === 0) return true;
  return false;
}

/**
 * Countries whose full postcode identifies a building or a small handful of them.
 *
 * SMALL AND CONSERVATIVE ON PURPOSE. Every entry here weakens a check, so an entry added on a hunch
 * costs more than an omission does: a country left out means corroboration falls back to the
 * street, which is the strict answer. Add one only with the postcode system in front of you.
 */
const BUILDING_PRECISE_POSTCODES = new Map([
  // Full formats only. Membership in this table is a claim that the value NAMES A BUILDING, and a
  // partial value does not: "W1" is a London postal district covering a large slice of the West End,
  // and treating it as building-precise made "Oxford Street, W1" a successful read and let unrelated
  // candidates merge. A country whose postcodes are building-precise does not make every string in
  // its postcode field one. (Codex, PR #10.)
  ['GB', /^[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}$/],
  ['NL', /^\d{4} ?[a-z]{2}$/],
  ['IE', /^[a-z]\d{2} ?[a-z\d]{4}$/],
  ['CA', /^[a-z]\d[a-z] ?\d[a-z]\d$/],
]);

/**
 * Does this postcode name a building?
 *
 * TWO CONDITIONS, and the second was missing everywhere this was used: the country's postcodes must
 * be building-level, AND the value must be a complete postcode in that country's format. Used by
 * all three callers — identity, corroboration and the building test — so the answer cannot drift
 * between them.
 */
export function postcodeNamesABuilding(country, postalCode) {
  const format = BUILDING_PRECISE_POSTCODES.get(country);
  if (format == null || typeof postalCode !== 'string') return false;
  return format.test(postalCode.trim().toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Substring matching, but not blind to word boundaries.
 *
 * `"1 oak st"` is a substring of `"11 oak st, porto"`, so a plain `includes` corroborated a
 * neighbouring building's address — one digit away from the listing and confidently wrong. House
 * numbers and postcodes are exactly the kind of short token where a prefix collision is likely
 * rather than exotic.
 */
/**
 * Separators that never appear INSIDE a postal address, used to cut a rendered blob into segments.
 *
 * Commas are deliberately absent: they are the punctuation an address is made of. Everything here
 * is punctuation that joins an address to something that is not one — a dash before an editorial
 * note, a colon before a list, a pipe or a newline between fields of a layout.
 */
const SEGMENT_BREAK = /[\n\r\t|;:·•—–]|\s{3,}/;

function containsWhole(haystack, needle) {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + needle.length] ?? '';
    // UNICODE, not ASCII. `/[a-z0-9]/` classified every non-Latin character as punctuation, so
    // "中山路1号" read as a whole-token match inside "新中山路1号" — a different street, admitted by a
    // boundary check that could not see the boundary. (Codex, PR #10.)
    const isWordish = (c) => c !== '' && /[\p{L}\p{N}]/u.test(c);
    if (!isWordish(before) && !isWordish(after)) return true;
    from = at + 1;
  }
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
  // A BUILDING IDENTIFIER, PLUS SOMETHING TO DISAMBIGUATE IT.
  //
  // Three bars were tried in this PR and each was too low by one component:
  //
  //   locality + country            "Lisbon, Portugal"          — a city
  //   postcode + country            "90210, US"                 — several square kilometres
  //   locality + postcode + country "Beverly Hills, 90210, US"  — still an area, just a smaller one
  //
  // Every one of them geocodes to a point that is confidently somewhere the hotel is not, and the
  // report would have counted all three as an address we could locate. The pattern is that none of
  // them names the BUILDING. A street does, and a locality or postcode is then what tells one
  // "1 Oak St" from the thousands of others.
  //
  // This costs nothing on the market we have measured: street is present on 100% of Booking,
  // Expedia and Hotels.com pages carrying structured data.
  //
  // NOTE THE DIVISION OF LABOUR with coarselyGeocodable below. This asks whether the PAGE
  // identified the listing — the bar for calling a read a success. That one asks which components
  // may leave the browser, and deliberately excludes the street we are requiring here. Knowing the
  // street and choosing not to send it is the entire coarse-geocoding design. (DECISIONS 13.)
  if (!components.streetNamesABuilding) return false;
  return Boolean(components.locality || components.postalCode);
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
