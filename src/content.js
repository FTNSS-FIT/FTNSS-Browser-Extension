// Content script — runs inside a listing page.
//
// A manifest content script is a classic script, so the modules are pulled in with a dynamic
// import() of extension-internal URLs. That keeps the harness at ZERO dependencies and ZERO build
// step: it loads unpacked, as-is. A bundler arrives when the product needs one, not before.
//
// NOTHING IN THIS FILE OR ANYTHING IT IMPORTS MAKES A NETWORK REQUEST. That is checked by a test,
// because it is the property the whole project rests on and "we didn't add one" is not evidence.

(async () => {
  const [
    { runExtraction },
    { mountRecorder, unmountRecorder },
    { saveRecord },
    { toTransmittablePoint, distanceMetres },
  ] =
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

  /**
   * Wait until the DOM stops changing, rather than for a fixed delay.
   *
   * A fixed timeout was wrong for a reason worth spelling out: it bounds how long we wait, not what
   * we are waiting FOR. During a slow soft navigation the URL flips to listing B while the DOM still
   * holds listing A, so extracting after a fixed delay reads A's markup and captures B's URL — and
   * the save-time URL check cannot catch it, because by then both URLs are B. That reconstructs the
   * exact mis-attribution round 1 was meant to eliminate, through a race instead of a stale read.
   * (Codex review round 2, PR #1.)
   *
   * Quiet-period detection is not a proof — a page could mutate forever, which is why there is a
   * ceiling — but it waits on the thing that actually matters, and the ceiling is recorded on the
   * record so a reading taken under an unsettled DOM is identifiable later rather than silently
   * mixed in.
   */
  function waitForStableDom({ quietMs = 300, maxMs = 3000 } = {}) {
    return new Promise((resolve) => {
      let timer;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(settle, quietMs);
      });
      const ceiling = setTimeout(() => settle(true), maxMs);

      function settle(hitCeiling = false) {
        clearTimeout(timer);
        clearTimeout(ceiling);
        observer.disconnect();
        resolve({ settled: !hitCeiling });
      }

      observer.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(settle, quietMs);
    });
  }

  async function measureCurrentPage({ softNavigation = false } = {}) {
    const myGeneration = (generation += 1);

    let domSettled = true;
    if (softNavigation) {
      // Nothing may remain on screen while we wait — a panel from the previous listing on a page
      // that is no longer that listing is worse than an empty corner.
      unmountRecorder();
      ({ settled: domSettled } = await waitForStableDom());
      // A newer navigation started while we waited; that one owns the page now.
      if (myGeneration !== generation) return;
    }

    // Captured AFTER the wait, so the URL and the DOM we are about to read belong to the same
    // moment as closely as we can establish.
    const capturedUrl = location.href;

    const extraction = runExtraction(document);

    // The URL moved while we were extracting — this reading cannot be attributed to either page.
    if (location.href !== capturedUrl || myGeneration !== generation) return;

    if (!worthMeasuring(extraction)) {
      // Do NOT leave a previous panel standing. Returning early here is what let listing A's reading
      // stay on screen after navigating to a page we decided not to measure.
      unmountRecorder();
      return;
    }

    // Latency the user would actually feel: from the page being ready to the panel being on screen.
    // Only meaningful for the initial load — after a soft navigation there is no new navigation
    // entry, so it is reported as null rather than as a number that means something else.
    const nav = performance.getEntriesByType('navigation')[0];
    const isSoftNavigation = softNavigation;
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
          // False when the DOM never went quiet within the ceiling. Such a reading is usable but
          // less trustworthy, and the report can exclude it rather than us pretending otherwise.
          domSettled,
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
    // Clear immediately and synchronously — the wait happens inside measureCurrentPage, and the
    // previous listing's panel must not survive even that long.
    unmountRecorder();
    void measureCurrentPage({ softNavigation: true });
  }
  setInterval(onMaybeNavigated, 1000);
  addEventListener('popstate', onMaybeNavigated);
  addEventListener('hashchange', onMaybeNavigated);
})();
