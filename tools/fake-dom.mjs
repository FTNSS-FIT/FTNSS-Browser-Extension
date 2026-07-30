// A four-method stand-in for Document, so the extractors can be tested without pulling in a DOM
// library. That is not minimalism for its own sake: a runtime dependency in this repo is a review
// finding, and a dev dependency in an extension project is still one more thing whose source nobody
// reads. The extractors only ever call querySelectorAll, textContent and getAttribute.

export function fakeDocument(selectorMap) {
  return {
    querySelectorAll(selector) {
      return selectorMap[selector] ?? [];
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
