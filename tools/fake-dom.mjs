// A four-method stand-in for Document, so the extractors can be tested without pulling in a DOM
// library. That is not minimalism for its own sake: a runtime dependency in this repo is a review
// finding, and a dev dependency in an extension project is still one more thing whose source nobody
// reads. The extractors only ever call querySelectorAll, textContent and getAttribute.

export function fakeDocument(selectorMap) {
  return {
    querySelectorAll(selector) {
      return selectorMap[selector] ?? [];
    },
    // Tier 1 reads the page's canonical url to identify which lodging node the page is about. The
    // stand-in has to answer that too, or every test silently exercises the no-identity fallback —
    // which is the path that was already covered.
    querySelector(selector) {
      return (selectorMap[selector] ?? [])[0] ?? null;
    },
  };
}

export function scriptNode(text) {
  return { textContent: text };
}

export function attrNode(attrs) {
  return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
}

export function textNode(text) {
  return { textContent: text };
}

/**
 * An element tree, so tier 3's block-boundary handling can be exercised.
 *
 * `textNode` above is a stand-in with no children — fine for "what does this element say", useless
 * for "where did the page put a boundary", which is what corroboration turns on.
 */
export function elementNode(tagName, children) {
  return {
    tagName,
    childNodes: children.map((child) =>
      typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child,
    ),
  };
}

/** Tier 1 only ever asks for one selector. */
export function ldJsonDocument(...blocks) {
  return fakeDocument({ 'script[type="application/ld+json"]': blocks.map(scriptNode) });
}

/** Tier 2 only ever asks for one selector. */
export function linkDocument(...urls) {
  return fakeDocument({
    'a[href], img[src], iframe[src]': urls.map((u) => attrNode({ href: u })),
  });
}
