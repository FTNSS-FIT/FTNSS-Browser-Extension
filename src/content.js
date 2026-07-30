// Content script — runs inside a listing page.
//
// IT RENDERS NOTHING. Its entire job is to read the page and publish what it read; the recorder UI
// lives in the extension popup.
//
// That split is the whole point. A panel mounted in the page sits in a document the page controls,
// so the page can hide it, move it, swallow its clicks, or watch what is typed into it — and the
// thing it displays is the "we could not read this page" state, whose entire value is that it cannot
// be silently absent. Three consecutive review rounds each found a new way to suppress or subvert an
// in-page panel, every one a variant of the same structural fact. Browser-owned UI is not a
// hardening of that design; it is the design that does not have the problem.
// (Codex review rounds 6–8, PR #1.)
//
// A manifest content script is a classic script, so modules are pulled in with a dynamic import()
// of extension-internal URLs — zero dependencies, zero build step.
//
// NOTHING IN THIS FILE OR ANYTHING IT IMPORTS MAKES A NETWORK REQUEST. A test asserts it.

(async () => {
  const [{ runExtraction }, { publishReading, siteLabelFor }] = await Promise.all([
    import(chrome.runtime.getURL('extract/index.js')),
    import(chrome.runtime.getURL('lib/storage.js')),
  ]);

  let generation = 0;

  // The signature of the page we last measured. Deliberately NOT a snapshot taken at navigation
  // time: such a snapshot already reflects a navigation that finished before the poll noticed it, so
  // comparing against it compares the new DOM with itself, concludes nothing changed, and reports a
  // false "page did not settle" on a perfectly readable listing. That biases the sample in the worst
  // available direction — it silently discards the fast, well-built pages.
  //
  // The accepted trade is that unrelated drift on the OLD page can also satisfy this comparison.
  // That error is visible: it costs a possibly-early read on a page the person is looking at and can
  // judge. The other error is invisible. (Codex review rounds 4, 7 and 8, PR #1.)
  let lastSignature = null;

  /** Page identity with the fragment excluded — `#photos` is not a different listing. */
  const pageIdentity = (href) => href.split('#')[0];

  function domSignature() {
    // DOM only, and body content only. The pathname changes before the DOM on a pushState
    // navigation, and the title changes before it too; both were tried, and both meant page chrome
    // changing counted as evidence the listing had.
    let ldLength = 0;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      ldLength += (script.textContent || '').length;
    }
    const main = document.querySelector('main') ?? document.body;
    return `${ldLength}|${main ? main.childElementCount : 0}|${document.querySelectorAll('img').length}`;
  }

  /** Resolve once the DOM has stopped changing, or once we give up waiting. */
  function waitForStableDom({ quietMs = 300, maxMs = 5000 } = {}) {
    return new Promise((resolve) => {
      let timer;
      let mutated = false;
      const observer = new MutationObserver(() => {
        mutated = true;
        clearTimeout(timer);
        timer = setTimeout(settle, quietMs);
      });
      const ceiling = setTimeout(() => settle(true), maxMs);
      function settle(hitCeiling = false) {
        clearTimeout(timer);
        clearTimeout(ceiling);
        observer.disconnect();
        resolve({ settled: !hitCeiling, mutated });
      }
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // No initial quiet timer: settling requires positive evidence that something changed.
    });
  }

  async function measureCurrentPage({
    softNavigation = false,
    navDetectedAt = null,
    latencyUncertaintyMs = 0,
  } = {}) {
    const myGeneration = (generation += 1);
    let domSettled = true;

    if (softNavigation) {
      const alreadyChanged = domSignature() !== lastSignature;
      const stability = await waitForStableDom();
      domSettled = stability.settled;
      if (myGeneration !== generation) return;

      if (!stability.mutated && !alreadyChanged) {
        // Publish the failure rather than returning silently. A page may be readable and merely
        // slower than the ceiling, and "nothing shown" is indistinguishable from "nothing found" —
        // the same ambiguity the never-show-an-empty-panel rule exists to prevent.
        await publishReading({
          site: siteLabelFor(location.hostname),
          identity: pageIdentity(location.href),
          result: { status: 'not_found', reason: 'page did not settle after navigation' },
          tiers: { tier1: 'not_found', tier2: 'not_found', tier3: 'not_found' },
          timing: { totalMs: 0, readyToPanelMs: null },
          softNavigation: true,
          domSettled: false,
          latencyUncertaintyMs,
        });
        return;
      }
    }

    const identity = pageIdentity(location.href);
    const extraction = runExtraction(document);
    lastSignature = domSignature();

    // The page moved while we were extracting; this reading belongs to neither page.
    if (pageIdentity(location.href) !== identity || myGeneration !== generation) return;

    const nav = performance.getEntriesByType('navigation')[0];
    const readyMs = softNavigation
      ? navDetectedAt == null
        ? null
        : Math.max(0, performance.now() - navDetectedAt)
      : nav
        ? Math.max(0, performance.now() - nav.domContentLoadedEventEnd)
        : null;

    await publishReading({
      site: siteLabelFor(location.hostname),
      identity,
      result: extraction.result,
      tiers: {
        tier1: extraction.tiers.tier1.status,
        tier2: extraction.tiers.tier2.status,
        tier3: extraction.tiers.tier3.status,
      },
      timing: { ...extraction.timing, readyToPanelMs: readyMs == null ? null : Math.round(readyMs) },
      softNavigation,
      domSettled,
      latencyUncertaintyMs: softNavigation ? latencyUncertaintyMs : 0,
    });
  }

  measureCurrentPage();

  let lastIdentity = pageIdentity(location.href);
  function onMaybeNavigated(latencyUncertaintyMs) {
    const current = pageIdentity(location.href);
    if (current === lastIdentity) return;
    lastIdentity = current;
    void measureCurrentPage({
      softNavigation: true,
      navDetectedAt: performance.now(),
      latencyUncertaintyMs,
    });
  }

  // 250ms: the poll interval IS the latency measurement's error bar, so a slower poll buys nothing
  // and costs accuracy in the number this phase exists to produce.
  const POLL_MS = 250;
  setInterval(() => onMaybeNavigated(POLL_MS), POLL_MS);
  // These fire synchronously with the navigation, so detection through them carries no uncertainty.
  addEventListener('popstate', () => onMaybeNavigated(0));
  addEventListener('hashchange', () => onMaybeNavigated(0));
})();
