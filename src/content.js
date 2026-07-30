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
  const [{ runExtraction }, { publishReading, invalidateReading, siteLabelFor }] = await Promise.all([
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
  /** The page identity the most recent published reading describes. Never leaves this script. */
  let lastPublishedIdentity = null;

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

  // A MutationObserver that runs for the LIFETIME of the page, not one started per navigation.
  //
  // A per-navigation observer can only see what happens after it starts, so a soft navigation that
  // completed before the 250ms poll noticed it produced no records at all — the wait then ran to the
  // full ceiling and published a false `not_found` for a listing that was sitting there, readable.
  // The signature check was meant to cover that case and cannot: a navigation that rewrites text and
  // attributes in place leaves element counts, image counts and JSON-LD length identical.
  //
  // Watching continuously means the evidence exists before we go looking for it.
  // (Codex review round 12, PR #1.)
  let mutationCount = 0;
  let lastMutationAt = 0;
  new MutationObserver(() => {
    mutationCount += 1;
    lastMutationAt = performance.now();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  /** Resolve once the DOM has stopped changing, or once we give up waiting. */
  function waitForStableDom({ quietMs = 300, maxMs = 5000, alreadyChanged = false } = {}) {
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
      // childList alone was not enough. A soft navigation that rewrites text and attributes in
      // place — same number of elements, same number of images — produced no childList records, so
      // the observer saw nothing, the wait ran to the ceiling, and a perfectly readable listing was
      // published as `not_found`. Watching text and attributes costs more callbacks and buys the
      // difference between measuring a page and inventing a failure for it.
      // (Codex review round 11, PR #1.)
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      // Start the quiet timer ONLY when the change is already established. Without this, a soft
      // navigation that completed before the poll noticed it produced no further mutations, so the
      // wait ran to the full ceiling — five seconds added to the measured latency of exactly the
      // FASTEST pages, which then failed the budget. The metric would have punished the sites that
      // performed best. (Codex review round 9, PR #1.)
      //
      // Where nothing has changed yet, there is still no initial timer: settling then requires
      // positive evidence that something moved.
      if (alreadyChanged) timer = setTimeout(settle, quietMs);
    });
  }

  let lastPublishedStatus = null;

  async function measureCurrentPage({
    softNavigation = false,
    navDetectedAt = null,
    latencyUncertaintyMs = 0,
    mutationCountAtNavigation = 0,
    isRetry = false,
    provisional = false,
  } = {}) {
    const myGeneration = (generation += 1);
    let domSettled = true;

    if (softNavigation) {
      // Three independent signals that the page has moved on, because each one alone has a blind
      // spot: the signature misses in-place text rewrites, the observer we are about to start misses
      // anything that already finished, and the persistent counter is the one that catches a
      // navigation completed before the poll noticed it.
      const mutatedSinceNavigation = mutationCount > mutationCountAtNavigation;
      const mutatedJustNow = performance.now() - lastMutationAt < 1500;
      const alreadyChanged =
        domSignature() !== lastSignature || mutatedSinceNavigation || mutatedJustNow;

      const stability = await waitForStableDom({ alreadyChanged });
      domSettled = stability.settled;
      if (myGeneration !== generation) return;

      if (!stability.mutated && !alreadyChanged) {
        // Genuinely nothing changed anywhere: not before we looked, not while we waited. Whatever is
        // on screen still belongs to the previous listing.
        // Publish the failure rather than returning silently. A page may be readable and merely
        // slower than the ceiling, and "nothing shown" is indistinguishable from "nothing found" —
        // the same ambiguity the never-show-an-empty-panel rule exists to prevent.
        await publishReading({
          site: siteLabelFor(location.hostname),
          seq: myGeneration,
          identity: pageIdentity(location.href),
          result: { status: 'not_found', reason: 'page did not settle after navigation' },
          tiers: { tier1: 'not_found', tier2: 'not_found', tier3: 'not_found' },
          timing: { totalMs: 0, readingReadyMs: null },
          softNavigation: true,
          domSettled: false,
          latencyUncertaintyMs,
        });
        // Bind the failure to the page it describes, exactly as a success is bound.
        //
        // Without this, FTNSS_CONFIRM rejected the reading it had just published, so "Confirm no
        // read" could never be recorded — and that removed one whole CLASS of misses from the
        // sample: pages that fail to settle. Those are not randomly distributed; they are the slow
        // and the heavy ones. A sample that cannot record them reports a hit rate for the easy half
        // of the web. (Codex review round 18, PR #1.)
        lastPublishedIdentity = pageIdentity(location.href);
        lastPublishedStatus = 'not_found';
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
      seq: myGeneration,
      identity,
      result: extraction.result,
      tiers: {
        tier1: extraction.tiers.tier1.status,
        tier2: extraction.tiers.tier2.status,
        tier3: extraction.tiers.tier3.status,
      },
      timing: { ...extraction.timing, readingReadyMs: readyMs == null ? null : Math.round(readyMs) },
      softNavigation,
      domSettled,
      latencyUncertaintyMs: softNavigation ? latencyUncertaintyMs : 0,
      // A retry's latency is measured to the moment the reading actually became available, which is
      // the honest number: the product would have waited exactly that long too.
      retried: isRetry,
      // A NOT-YET-FINAL failure. The first `not_found` was published immediately and stayed
      // recordable for the 2.5s of each retry — so "Confirm no read" could be pressed on a page
      // whose coordinates were about to appear, writing a false miss that no later success could
      // undo. A provisional failure is shown but cannot be recorded.
      // (Codex review round 19, PR #1.)
      provisional: provisional && extraction.result.status === 'not_found',
    });
    lastPublishedStatus = extraction.result.status;
    lastPublishedIdentity = identity;
    return extraction.result;
  }

  /**
   * Measure on load, then keep trying for a short while if nothing was readable.
   *
   * Extraction ran once at `document_idle` and never again unless the URL changed. Both measured
   * sites render substantial content asynchronously, so a listing whose data lands a moment after
   * idle produced a `not_found` that stayed recordable while the page sat there perfectly readable.
   * That error is not random: it falls on slower pages and slower connections, so the measured hit
   * rate would have been biased upward by exactly the cases the product will find hardest.
   *
   * Bounded, and stops as soon as something is found — this retries a failure, it does not poll a
   * success. (Codex review round 16, PR #1.)
   */
  async function measureOnLoad() {
    const result = await measureCurrentPage({ provisional: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (result?.status !== 'not_found' && lastPublishedStatus !== 'not_found') return;
      const before = generation;
      await waitForStableDom({ alreadyChanged: false, maxMs: 2500 });
      // A real navigation happened while we waited; it owns the page now.
      if (generation !== before) return;
      const isLastAttempt = attempt === 2;
      const retry = await measureCurrentPage({ isRetry: true, provisional: !isLastAttempt });
      if (retry?.status !== 'not_found') return;
    }
  }

  void measureOnLoad();

  /**
   * Answer "is the reading you published still for the page you are on?" — with a BOOLEAN.
   *
   * Where the Navigation API is unavailable, a same-document navigation is only noticed at the next
   * poll, and during that window the stored reading for listing A is still the tab's current one.
   * The popup's own revalidation cannot see the problem, because the stale reading is exactly what
   * it re-reads. Asking the content script closes it, because the content script is the only
   * component that can compare against `location.href` right now.
   *
   * The reply is a boolean and a sequence number. Never the URL: the answer to "are these the same?"
   * does not require sending the thing being compared. (Codex review round 16, PR #1.)
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // From our own extension, and from an extension page rather than another content script —
    // a popup message has no `sender.tab`.
    if (sender.id !== chrome.runtime.id || sender.tab != null) return false;
    if (message?.type !== 'FTNSS_CONFIRM') return false;
    sendResponse({
      current: lastPublishedIdentity != null && lastPublishedIdentity === pageIdentity(location.href),
      seq: generation,
    });
    return true;
  });

  let lastIdentity = pageIdentity(location.href);
  function onMaybeNavigated(latencyUncertaintyMs) {
    const current = pageIdentity(location.href);
    if (current === lastIdentity) {
      // `navigate` fires BEFORE the URL updates, so the first look can legitimately see the old one.
      // Re-check once the navigation has committed rather than dropping the earliest — and cheapest
      // — signal we get.
      if (latencyUncertaintyMs === 0) {
        queueMicrotask(() => {
          if (pageIdentity(location.href) !== lastIdentity) onMaybeNavigated(0);
        });
      }
      return;
    }
    lastIdentity = current;
    // INVALIDATE FIRST, synchronously. Remeasuring is asynchronous — it waits for the DOM to settle,
    // which can take up to the ceiling — and for that whole window the previous listing's reading
    // was still the tab's "current page". A soft navigation does not fire the browser-level load
    // event the service worker watches, so nothing else would have cleared it: the popup could show
    // and record listing A's coordinates while the person was looking at listing B, for seconds.
    // (Codex review round 11, PR #1.)
    void invalidateReading(generation + 1);
    // Snapshot the mutation counter BEFORE the async work, so "did anything change because of this
    // navigation" is answerable afterwards.
    const mutationCountAtNavigation = mutationCount;
    void measureCurrentPage({
      softNavigation: true,
      navDetectedAt: performance.now(),
      latencyUncertaintyMs,
      mutationCountAtNavigation,
    });
  }

  // THE NAVIGATION API IS THE PRIMARY SIGNAL, where the browser has one.
  //
  // `pushState` fires no event of its own: not `popstate`, which only covers history traversal, and
  // nothing the service worker sees either, because a same-document navigation is not a tab load.
  // So until the poll came round, listing A's reading was still valid for listing B — a window of up
  // to a full poll interval in which the popup could show, and record, the wrong page.
  //
  // The `navigate` event closes it: it fires synchronously, before the navigation commits, and it
  // covers pushState and replaceState. The alternative was patching `history.pushState`, which puts
  // our code in the page's own call path — deliberately avoided, because a content script inside a
  // hostile page should not become part of how that page works.
  //
  // The listeners below remain as a fallback for browsers without the Navigation API. There the
  // residual window is one poll interval, which is why the popup revalidates a reading before
  // recording it rather than trusting that detection was timely. (Codex review round 13, PR #1.)
  if (typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigate', () => onMaybeNavigated(0));
  }

  // 250ms: the poll interval IS the latency error bar on browsers relying on it, so a slower poll
  // buys nothing and costs accuracy in the number this phase exists to produce.
  const POLL_MS = 250;
  setInterval(() => onMaybeNavigated(POLL_MS), POLL_MS);
  // popstate and hashchange fire synchronously with the navigation, so detection carries no
  // uncertainty; they cover history traversal, which `navigate` also reports.
  addEventListener('popstate', () => onMaybeNavigated(0));
  addEventListener('hashchange', () => onMaybeNavigated(0));
})();
