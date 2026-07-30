// The tiered runner. Tries structured data, then map links, then address text, and reports which
// tier answered and how long it took.
//
// ALL THREE TIERS ALWAYS RUN, even after one succeeds. In the shipped product that would be waste;
// here it is the point — we are measuring per-tier availability, and stopping at the first hit
// would make tiers 2 and 3 unmeasurable on exactly the pages where tier 1 works. The `result` field
// is what the product would have used; the `tiers` field is what we are here to learn.

import { extractFromStructuredData } from './tier1-structured-data.js';
import { extractFromMapLinks } from './tier2-map-links.js';
import { extractFromAddressText } from './tier3-address-text.js';
import { isFound, isFoundAddress } from './result.js';

function time(fn) {
  const start = performance.now();
  let value;
  try {
    value = fn();
  } catch (err) {
    // A page that makes an extractor throw must not take the panel down with it. The message is
    // kept for diagnosis; the error object is NOT, because it can carry page-derived context we
    // have no reason to hold on to.
    value = { status: 'not_found', reason: `threw: ${err && err.name ? err.name : 'Error'}` };
  }
  return { value, ms: Math.round((performance.now() - start) * 100) / 100 };
}

/**
 * @param {Document} doc
 * @returns {{
 *   result: object,
 *   tiers: {tier1: object, tier2: object, tier3: object},
 *   timing: {tier1Ms: number, tier2Ms: number, tier3Ms: number, totalMs: number}
 * }}
 */
export function runExtraction(doc) {
  const t1 = time(() => extractFromStructuredData(doc));
  const t2 = time(() => extractFromMapLinks(doc));
  const t3 = time(() => extractFromAddressText(doc));

  // Precedence is tier order, and it is deliberate: a coordinate the site published for machines
  // beats a pin position, which beats a string we have not resolved.
  let result;
  if (isFound(t1.value)) result = t1.value;
  else if (isFound(t2.value)) result = t2.value;
  else if (isFoundAddress(t3.value)) result = t3.value;
  else result = { status: 'not_found', reason: 'all three tiers failed' };

  return {
    result,
    tiers: { tier1: t1.value, tier2: t2.value, tier3: t3.value },
    timing: {
      tier1Ms: t1.ms,
      tier2Ms: t2.ms,
      tier3Ms: t3.ms,
      totalMs: Math.round((t1.ms + t2.ms + t3.ms) * 100) / 100,
    },
  };
}
