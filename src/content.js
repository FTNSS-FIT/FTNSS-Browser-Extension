// Content script — reads the listing page, ON DEMAND.
//
// IT RENDERS NOTHING AND IT PUBLISHES NOTHING. It waits to be asked. When the popup opens, it
// extracts from the page as it is at that instant and returns the result.
//
// WHY THIS SHAPE — the important comment in this repository.
//
// The previous design measured continuously and published readings into shared storage, where the
// popup later picked them up. That created one problem and then spent ten review rounds failing to
// solve it: a stored reading can describe a page you have already left. Booking and Airbnb are both
// pushState applications, so the URL changes without a load, and every attempt to detect that from
// the outside — polling, mutation observers, DOM signatures, document ids, sequence numbers,
// navigation epochs — was a heuristic guessing at a transition the page never announces. Each fix
// closed one gap and opened another, and the failure was always the same shape: listing A's
// coordinates presented as listing B's.
//
// Reading on demand removes the problem rather than defending against it. The reading is taken
// milliseconds before it is displayed, from the page currently on screen, because the person opened
// the popup. There is no window in which it can go stale: it does not exist before it is needed and
// is not kept afterwards.
//
// What remains is a small navigation signal used ONLY to decide whether the "how long until this
// page became readable" timer still applies. If that signal is wrong, the cost is a latency reported
// as unmeasured — never a coordinate attributed to the wrong page. Correctness no longer depends on
// getting navigation detection right, which is the entire point of the change.
//
// NOTHING IN THIS FILE OR ANYTHING IT IMPORTS MAKES A NETWORK REQUEST. A test asserts it.

(async () => {
  const { runExtraction } = await import(chrome.runtime.getURL('extract/index.js'));

  /** Page identity INCLUDING the fragment: some sites drive listing content from the hash. */
  const identityOf = () => location.href;

  // ── Readiness timing ────────────────────────────────────────────────────────
  //
  // Measured once per page: how long from the page being ready until an extraction first succeeds.
  // That is the latency the product's own panel would inherit. It deliberately excludes how long the
  // person took to open the popup, which would measure the operator rather than the page.
  let readinessIdentity = identityOf();
  let readingReadyMs = null;
  let readinessSettled = false;

  function pageReadyAt() {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? nav.domContentLoadedEventEnd : null;
  }

  async function watchForReadiness() {
    const startedFor = readinessIdentity;
    const readyAt = pageReadyAt();
    // Poll briefly for the page to become readable. Both measured sites render asynchronously, so a
    // listing whose data lands just after load is readable rather than absent — and calling it
    // absent would bias the hit rate upward, because the pages that do this are the slow, heavy
    // ones the product will find hardest.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (readinessIdentity !== startedFor) return; // navigated; this measurement is void
      if (runExtraction(document).result.status !== 'not_found') {
        readingReadyMs = readyAt == null ? null : Math.max(0, performance.now() - readyAt);
        readinessSettled = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Never became readable within five seconds. It may still become readable later; the timer
    // simply has no answer, and reporting null is honest where reporting a number is not.
    readinessSettled = true;
  }

  void watchForReadiness();

  function onNavigated() {
    if (identityOf() === readinessIdentity) return;
    readinessIdentity = identityOf();
    readingReadyMs = null;
    readinessSettled = false;
    void watchForReadiness();
  }

  // Best-effort, and deliberately so: this governs a timing figure and nothing else. `navigate`
  // covers pushState where the browser has the Navigation API; the rest are fallbacks for browsers
  // that do not. A missed signal costs an unmeasured latency, not a wrong coordinate.
  if (typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigate', () => queueMicrotask(onNavigated));
  }
  addEventListener('popstate', onNavigated);
  addEventListener('hashchange', onNavigated);
  setInterval(onNavigated, 500);

  // ── The only thing this script exposes ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // From our own extension, and from an extension page rather than a content script — a message
    // sent by the popup has no `sender.tab`. A web page cannot reach this channel.
    if (sender.id !== chrome.runtime.id || sender.tab != null) return false;
    if (message?.type !== 'FTNSS_READ') return false;

    const started = performance.now();
    const extraction = runExtraction(document);

    sendResponse({
      result: extraction.result,
      tiers: {
        tier1: extraction.tiers.tier1.status,
        tier2: extraction.tiers.tier2.status,
        tier3: extraction.tiers.tier3.status,
      },
      timing: {
        totalMs: Math.round((performance.now() - started) * 100) / 100,
        // Null when this page has not yet become readable, or when a navigation voided the
        // measurement. Null means unmeasured; the report counts it separately and never as a pass.
        readingReadyMs: readinessSettled && readingReadyMs != null ? Math.round(readingReadyMs) : null,
      },
      // Still working out whether this page is readable. Shown to the operator, never recordable:
      // confirming "no read" on a page whose coordinates are about to appear writes a false miss,
      // and false misses are not randomly distributed — they fall on the slow pages.
      provisional: !readinessSettled && extraction.result.status === 'not_found',
      // Compared against the operator's declared cohort IN THE BROWSER, to catch a mislabelled
      // session. Never persisted, never exported.
      detectedHost: location.hostname,
    });
    return true;
  });
})();
