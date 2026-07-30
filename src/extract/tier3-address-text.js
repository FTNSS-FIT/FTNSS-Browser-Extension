// Tier 3 — the address as printed on screen. Last resort, and genuinely fragile: this is the tier
// that reads layout, and layout is what sites redesign.
//
// It yields an address STRING and stops there. Turning that into a coordinate needs a geocoder,
// which is a network call, and this harness makes none — so phase 1 can measure how often an
// address is *present*, but not how often geocoding gets it right. That gap is stated in the report
// rather than papered over; see docs/PHASE-1-MEASUREMENT.md.
//
// SECURITY: page text is attacker-controlled. It is only ever read, length-capped, and stored
// locally. It is never rendered as markup and never sent anywhere.

import { foundAddress, notFound } from './result.js';

const MAX_ADDRESS_CHARS = 300;

/**
 * Ordered by how much the page is telling us it is an address. Microdata and the `address` element
 * are explicit claims; the class-name selectors are guesses and are last.
 */
const SELECTORS = [
  '[itemprop="address"]',
  '[itemtype*="PostalAddress"]',
  'address',
  '[data-testid*="address" i]',
  '[class*="address" i]',
];

function cleanText(node) {
  const raw = node.textContent || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ADDRESS_CHARS);
}

/**
 * An address needs a digit and enough length to be more than a label. "Address" and "Show address"
 * both match a class-name selector and neither is an address.
 */
function looksLikeAddress(text) {
  return text.length >= 8 && /\d/.test(text) && /\p{L}/u.test(text);
}

/**
 * @param {Document} doc
 */
export function extractFromAddressText(doc) {
  for (const selector of SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch {
      continue; // a selector this file got wrong must not take the whole tier down
    }
    for (const node of nodes) {
      const text = cleanText(node);
      if (looksLikeAddress(text)) {
        return foundAddress({ address: text, source: `text ${selector}` });
      }
    }
  }
  return notFound('no address-shaped text found');
}
