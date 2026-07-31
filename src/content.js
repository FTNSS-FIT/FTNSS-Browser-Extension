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
  /**
   * An opaque token for the page currently loaded. Random, meaningless, and regenerated on every
   * navigation — it says nothing about where anyone is, and exists only so the popup can ask "is
   * this still the same page you read?" without either side handling a URL.
   */
  let pageToken = crypto.randomUUID();
  /**
   * When this script first got to run, relative to the page being ready.
   *
   * Without it, `readingReadyMs` is unattributable. The first real session showed a p50 of 820ms
   * against an 800ms budget, which reads as an extraction problem — and it is not: every success
   * landed on the FIRST probe, and extraction itself costs 2.5–7ms. What the number was actually
   * measuring is how long the page took to reach `document_idle`, which is when a content script is
   * allowed to start.
   *
   * That still matters — the product's panel cannot appear sooner either — but it is a fact about
   * the site, and no amount of optimising our code moves it. Splitting the two means the report can
   * say which one blew the budget instead of implying it was us.
   */
  const scriptStartedMs = (() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? Math.max(0, Math.round(performance.now() - nav.domContentLoadedEventEnd)) : null;
  })();

  let readinessIdentity = identityOf();
  let readingReadyMs = null;
  let readinessSettled = false;
  /**
   * When the CURRENT page became ready, on the performance timeline.
   *
   * For the initial load this is the navigation entry. For a same-document navigation there is no
   * new navigation entry, and using the old one is not merely imprecise — it is wrong by however
   * long the tab has been open. A listing opened twenty minutes into a session was being credited
   * with a twenty-minute readiness time, which does not fail the budget by a little; it corrupts the
   * latency distribution outright. (Codex review round 21, PR #1.)
   */
  let pageReadyAt = (() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? nav.domContentLoadedEventEnd : null;
  })();
  /**
   * TWO uncertainties, in OPPOSITE directions. They were one field, added together, which was wrong
   * for half of what it contained.
   *
   *   navigationDelayMs — the navigation may have been noticed LATE, so the baseline was set late,
   *                       so the measured duration is too SMALL. True latency ≤ measured + this.
   *   probeDelayMs      — the coordinate appeared somewhere between two probes, so we saw it late,
   *                       so the measured duration is too LARGE. True latency ≥ measured − this.
   *
   * Summing them and calling the total a worst case inflated every probe-delayed reading: a 750ms
   * read with 250ms of probe delay is bounded ABOVE by 750ms, and was being reported as possibly
   * 1000ms and excluded from hits. The instrument was penalising readings for how carefully it had
   * measured them. (Codex review round 25, PR #1.)
   */
  let navigationDelayMs = 0;
  let probeDelayMs = 0;
  /** When address text (tier 3) first appeared. A different event from a coordinate appearing. */
  let addressReadyMs = null;

  async function watchForReadiness() {
    const startedFor = readinessIdentity;
    const readyAt = pageReadyAt;
    /** When we last looked and found nothing. The gap to the next look is the detection error. */
    let lastProbeAt = null;
    // Poll briefly for the page to become readable. Both measured sites render asynchronously, so a
    // listing whose data lands just after load is readable rather than absent — and calling it
    // absent would bias the hit rate upward, because the pages that do this are the slow, heavy
    // ones the product will find hardest.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (readinessIdentity !== startedFor) return; // navigated; this measurement is void
      // ONLY a coordinate settles this timer.
      //
      // `found_address` used to settle it, and a hit requires coordinates — so if address text
      // appeared at 100ms and the coordinate at 1000ms, the coordinate was credited with the
      // address's timing and passed an 800ms budget it had actually missed. The two are measured
      // separately because they are different events.
      // (Codex review round 21, PR #1.)
      const status = runExtraction(document).result.status;
      if (status === 'found') {
        readingReadyMs = readyAt == null ? null : Math.max(0, performance.now() - readyAt);
        // The coordinate became available at some point between the previous probe and this one, so
        // the true readiness is up to one probe interval EARLIER than measured. Without carrying
        // that, a coordinate genuinely available at 700ms but first observed at 850ms is classified
        // as over an 800ms budget it never missed — and the report has no way to tell.
        // (Codex review round 23, PR #1.)
        probeDelayMs = lastProbeAt == null ? 0 : Math.round(performance.now() - lastProbeAt);
        readinessSettled = true;
        return;
      }
      lastProbeAt = performance.now();
      if (status === 'found_address' && addressReadyMs == null) {
        addressReadyMs = readyAt == null ? null : Math.max(0, performance.now() - readyAt);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Never became readable within five seconds. It may still become readable later; the timer
    // simply has no answer, and reporting null is honest where reporting a number is not.
    readinessSettled = true;
  }

  void watchForReadiness();

  function onNavigated(uncertaintyMs) {
    if (identityOf() === readinessIdentity) return;
    readinessIdentity = identityOf();
    pageToken = crypto.randomUUID();
    readingReadyMs = null;
    addressReadyMs = null;
    readinessSettled = false;
    // A same-document navigation has no navigation entry, so NOW is the baseline. This is the fix
    // for readiness times measured from a document loaded minutes earlier.
    pageReadyAt = performance.now();
    navigationDelayMs = uncertaintyMs;
    probeDelayMs = 0;
    void watchForReadiness();
  }

  // Best-effort, and deliberately so: this governs a timing figure and nothing else. `navigate`
  // covers pushState where the browser has the Navigation API; the rest are fallbacks for browsers
  // that do not. A missed signal costs an unmeasured latency, not a wrong coordinate.
  if (typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function') {
    // Fires synchronously with the navigation, so detection through it carries no uncertainty.
    navigation.addEventListener('navigate', () => queueMicrotask(() => onNavigated(0)));
  }
  addEventListener('popstate', () => onNavigated(0));
  addEventListener('hashchange', () => onNavigated(0));
  // Fallback for browsers without the Navigation API. The interval IS the error bar on the readiness
  // figure, which is why it is carried on the reading rather than quietly ignored.
  const POLL_MS = 500;
  setInterval(() => onNavigated(POLL_MS), POLL_MS);

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
        // Why each tier gave up. A miss that only says "not_found" three times records that
        // something went wrong and nothing about what — and telling those cases apart is most of
        // what this phase is for.
        tier1Reason: extraction.tiers.tier1.reason ?? null,
        tier2Reason: extraction.tiers.tier2.reason ?? null,
        tier3Reason: extraction.tiers.tier3.reason ?? null,
      },
      timing: {
        totalMs: Math.round((performance.now() - started) * 100) / 100,
        // Null when this page has not yet become readable, or when a navigation voided the
        // measurement. Null means unmeasured; the report counts it separately and never as a pass.
        readingReadyMs: readinessSettled && readingReadyMs != null ? Math.round(readingReadyMs) : null,
        // Measured separately, because address text appearing is not the same event as a coordinate
        // appearing and only the latter can satisfy the hit definition.
        addressReadyMs: addressReadyMs == null ? null : Math.round(addressReadyMs),
        // Kept separate: they bound the true value from opposite sides.
        navigationDelayMs,
        probeDelayMs,
        // How much of readingReadyMs was the page getting to document_idle, rather than us.
        scriptStartedMs,
      },
      // Still working out whether this page is readable. Shown to the operator, never recordable:
      // confirming "no read" on a page whose coordinates are about to appear writes a false miss,
      // and false misses are not randomly distributed — they fall on the slow pages.
      // ANY non-coordinate result is provisional while polling continues, not just `not_found`.
      //
      // Address text often appears before the JSON-LD block or the map does. Treating only
      // `not_found` as provisional meant a `found_address` was immediately offered for a verdict —
      // and the only verdicts available without a coordinate are "no read" and "can't tell", so a
      // page whose coordinate was one second away could be recorded as a miss.
      // (Codex review round 22, PR #1.)
      // Presence flags and a country code, never an address. See extract/address-components.js.
      addressComponents: extraction.addressComponents,
      provisional: !readinessSettled && extraction.result.status !== 'found',
      pageToken,
      // Compared against the operator's declared cohort IN THE BROWSER, to catch a mislabelled
      // session. Never persisted, never exported.
      detectedHost: location.hostname,
    });
    return true;
  });
})();
