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
/** Nodes examined across ALL selectors. A page controls how many elements match ours. */
const MAX_NODES = 200;
/** Characters read from one node before we stop. See boundedText. */
const MAX_READ_CHARS = 2000;

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

/**
 * Read at most MAX_READ_CHARS from a node, walking its text nodes rather than taking `textContent`.
 *
 * `textContent` materialises the ENTIRE subtree before any cap can apply, so a page could hand us a
 * megabyte-sized matching element and make us build and normalise the whole string — and because
 * readiness probes re-run extraction every 250ms, it would do so repeatedly, blocking the page and
 * the popup with it. Walking and stopping early bounds the work rather than bounding the result.
 * (Codex review round 24, PR #1.)
 */
function boundedText(node) {
  let out = '';
  const stack = [node];
  let visited = 0;
  while (stack.length > 0 && out.length < MAX_READ_CHARS && visited < 400) {
    const current = stack.pop();
    visited += 1;
    if (current == null) continue;
    if (current.nodeType === 3) {
      out += current.nodeValue ?? '';
      continue;
    }
    const children = current.childNodes;
    if (children == null) {
      // A stand-in node in tests, or an element with no child list — fall back to its own text,
      // still capped.
      out += (current.textContent ?? '').slice(0, MAX_READ_CHARS);
      continue;
    }
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return out.slice(0, MAX_READ_CHARS);
}

function cleanText(node) {
  return boundedText(node).replace(/\s+/g, ' ').trim().slice(0, MAX_ADDRESS_CHARS);
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
  let visited = 0;
  for (const selector of SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch {
      continue; // a selector this file got wrong must not take the whole tier down
    }
    for (const node of nodes) {
      // Bounded across ALL selectors, not per selector: a page chooses how many elements match, and
      // an unbounded loop is work it can commission for free — repeatedly, since readiness probes
      // re-run this every 250ms.
      if (visited >= MAX_NODES) return notFound('too many candidate elements to examine');
      visited += 1;
      const text = cleanText(node);
      if (looksLikeAddress(text)) {
        return foundAddress({ address: text, source: `text ${selector}` });
      }
    }
  }
  return notFound('no address-shaped text found');
}
