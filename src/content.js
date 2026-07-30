// Content script — runs inside a listing page.
//
// A manifest content script is a classic script, so the modules are pulled in with a dynamic
// import() of extension-internal URLs. That keeps the harness at ZERO dependencies and ZERO build
// step: it loads unpacked, as-is. A bundler arrives when the product needs one, not before.
//
// NOTHING IN THIS FILE OR ANYTHING IT IMPORTS MAKES A NETWORK REQUEST. That is checked by a test,
// because it is the property the whole project rests on and "we didn't add one" is not evidence.

(async () => {
  const [{ runExtraction }, { mountRecorder }, { saveRecord }, { toTransmittablePoint, distanceMetres }] =
    await Promise.all([
      import(chrome.runtime.getURL('extract/index.js')),
      import(chrome.runtime.getURL('panel/recorder.js')),
      import(chrome.runtime.getURL('lib/storage.js')),
      import(chrome.runtime.getURL('lib/geo.js')),
    ]);

  /**
   * Is this page worth measuring at all? Deliberately INCLUSIVE: a page wrongly measured costs the
   * person one "not a listing" click, whereas a listing wrongly skipped is invisible to the sample —
   * and it is invisible in a biased way, because the pages we fail to recognise are correlated with
   * the pages we fail to read. That would flatter the hit rate, which is the one number this whole
   * phase exists to produce. (Widened after Codex review, PR #1.)
   */
  function worthMeasuring(extraction) {
    if (extraction.result.status !== 'not_found') return true;
    if (extraction.tiers.tier1.status !== 'not_found') return true;
    if (/\/(hotel|hotels|rooms|stays|property|accommodation|h)\//i.test(location.pathname)) return true;
    return document.querySelector('script[type="application/ld+json"]') != null;
  }

  /**
   * Booking.com and Airbnb are both pushState applications: moving from listing A to listing B does
   * not reload the page. Extracting once at document_idle and reading location.href later meant the
   * panel kept showing A's coordinates while the URL said B — and, far worse, SAVING recorded A's
   * coordinates against B's URL. That is silent corruption of the measurement this phase exists to
   * produce, and it would have looked like a plausible reading rather than an error.
   * (Codex review, PR #1.)
   *
   * The fix has two halves, and both are needed:
   *   1. re-extract whenever the URL changes, so what is displayed matches what is on screen;
   *   2. capture the URL AT EXTRACTION TIME and bind it into the saved record, so a save can never
   *      attribute a reading to a page it did not come from — even if navigation happens between
   *      the read and the click.
   */
  let generation = 0;

  function measureCurrentPage() {
    const capturedUrl = location.href;
    const myGeneration = (generation += 1);

    const extraction = runExtraction(document);
    if (!worthMeasuring(extraction)) return;

    // Latency the user would actually feel: from the page being ready to the panel being on screen.
    // Only meaningful for the initial load — after a soft navigation there is no new navigation
    // entry, so it is reported as null rather than as a number that means something else.
    const nav = performance.getEntriesByType('navigation')[0];
    const isSoftNavigation = myGeneration > 1;
    const readyToPanelMs =
      isSoftNavigation || !nav ? null : Math.max(0, performance.now() - nav.domContentLoadedEventEnd);

    mountRecorder({
      extraction,
      readyToPanelMs,
      capturedUrl,
      onSave: async ({ verdict, precisionVerdict, groundTruthRaw, note }) => {
        // Refuse to save a reading that belongs to a page the browser has already left. Without
        // this, a slow verdict on listing A lands on listing B's record.
        if (location.href !== capturedUrl) {
          throw new Error('page changed since this reading — re-record on the current listing');
        }

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
          // The URL extraction actually ran against — NOT location.href at save time.
          // Stored locally only; see the note at the top of lib/storage.js for why this harness
          // keeps a URL when the product never will.
          url: capturedUrl,
          site: location.hostname,
          recordedAt: new Date().toISOString(),
          softNavigation: isSoftNavigation,
          verdict,
          // What the person actually saw: whether the point is the building or a fuzzed area. The
          // extractor no longer guesses this, so it has to be observed.
          precisionVerdict: precisionVerdict ?? 'not_assessed',
          note,
          groundTruth,
          errorMetres,
          result: extraction.result,
          // What the product WOULD have transmitted. Recorded so the report can show the rounded
          // point is still good enough to answer the question — the claim the privacy design rests on.
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
          timing: {
            ...extraction.timing,
            readyToPanelMs: readyToPanelMs == null ? null : Math.round(readyToPanelMs),
          },
        });
      },
    });
  }

  measureCurrentPage();

  // Soft-navigation detection. The Navigation API would be tidier but is not available everywhere,
  // and history.pushState is patched by the page's own framework — wrapping it would put our code
  // in the page's call path, which is exactly the entanglement a content script should avoid. A
  // poll is dumber, cannot be defeated by the page, and costs a string comparison per second.
  let lastUrl = location.href;
  function onMaybeNavigated() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // Let the framework render the new listing before reading it. Too early and every soft
    // navigation reads as an unreadable page.
    setTimeout(measureCurrentPage, 600);
  }
  setInterval(onMaybeNavigated, 1000);
  addEventListener('popstate', onMaybeNavigated);
  addEventListener('hashchange', onMaybeNavigated);
})();
