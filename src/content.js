// Content script — runs inside a listing page.
//
// A manifest content script is a classic script, so the modules are pulled in with a dynamic
// import() of extension-internal URLs. That keeps the harness at ZERO dependencies and ZERO build
// step: it loads unpacked, as-is. A bundler arrives when the product needs one, not before.
//
// NOTHING IN THIS FILE OR ANYTHING IT IMPORTS MAKES A NETWORK REQUEST. That is checked by a test,
// because it is the property the whole project rests on and "we didn't add one" is not evidence.

(async () => {
  // Not every page under a matched host is a listing. Running the recorder on a search results page
  // or a help article would pollute the sample with pages the product would never have shown a
  // panel on.
  const looksLikeListing =
    document.querySelector('script[type="application/ld+json"]') != null ||
    /\/(hotel|rooms|stays|property)\//i.test(location.pathname);
  if (!looksLikeListing) return;

  const [{ runExtraction }, { mountRecorder }, { saveRecord }, { toTransmittablePoint, distanceMetres }] =
    await Promise.all([
      import(chrome.runtime.getURL('extract/index.js')),
      import(chrome.runtime.getURL('panel/recorder.js')),
      import(chrome.runtime.getURL('lib/storage.js')),
      import(chrome.runtime.getURL('lib/geo.js')),
    ]);

  const extraction = runExtraction(document);

  // Latency the user would actually feel: from the page being ready to the panel being on screen.
  // Anchored to the navigation entry rather than to script start, because script start already
  // excludes the time the browser spent getting here.
  const nav = performance.getEntriesByType('navigation')[0];
  const readyAt = nav ? nav.domContentLoadedEventEnd : 0;
  const readyToPanelMs = Math.max(0, performance.now() - readyAt);

  mountRecorder({
    extraction,
    readyToPanelMs,
    onSave: async ({ verdict, groundTruthRaw, note }) => {
      let groundTruth = null;
      let errorMetres = null;

      if (groundTruthRaw) {
        const parts = groundTruthRaw.split(',').map((p) => Number(p.trim()));
        if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
          groundTruth = { lat: parts[0], lon: parts[1] };
          if (extraction.result.status === 'found') {
            errorMetres = Math.round(distanceMetres(extraction.result, groundTruth));
          }
        }
      }

      await saveRecord({
        // Stored locally only — see the note at the top of lib/storage.js for why this harness keeps
        // a URL when the product never will.
        url: location.href,
        site: location.hostname,
        recordedAt: new Date().toISOString(),
        verdict,
        note,
        groundTruth,
        errorMetres,
        result: extraction.result,
        // What the product WOULD have transmitted. Recorded so the report can show that the rounded
        // point is still good enough to answer the question, which is the claim the privacy design
        // depends on.
        transmitted:
          extraction.result.status === 'found'
            ? toTransmittablePoint(extraction.result.lat, extraction.result.lon)
            : null,
        tiers: {
          tier1: extraction.tiers.tier1.status,
          tier2: extraction.tiers.tier2.status,
          tier3: extraction.tiers.tier3.status,
          tier1Reason: extraction.tiers.tier1.reason ?? null,
          tier2Reason: extraction.tiers.tier2.reason ?? null,
          tier3Reason: extraction.tiers.tier3.reason ?? null,
        },
        timing: { ...extraction.timing, readyToPanelMs: Math.round(readyToPanelMs) },
      });
    },
  });
})();
