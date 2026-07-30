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
    { saveRecord, siteLabelFor },
    { toTransmittablePoint, distanceMetres },
  ] =
    await Promise.all([
      import(chrome.runtime.getURL('extract/index.js')),
      import(chrome.runtime.getURL('panel/recorder.js')),
      import(chrome.runtime.getURL('lib/storage.js')),
      import(chrome.runtime.getURL('lib/geo.js')),
    ]);

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
  // A cheap fingerprint of what is currently rendered. Used to tell "the DOM has already been
  // replaced" from "the DOM has not changed yet", which a mutation observer alone cannot do
  // because it only sees changes that happen AFTER it starts watching.
  let lastSignature = null;

  function domSignature() {
    // DOM ONLY. This included location.pathname, which defeated the entire purpose: on a pushState
    // navigation the path changes BEFORE the DOM does, so the signature differed on a document that
    // had not been touched yet, the stabilisation wait was skipped, and listing A's markup was read
    // as listing B. A URL change is the QUESTION, never the evidence.
    // (Codex review round 5, PR #1.)
    let ldLength = 0;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      ldLength += (script.textContent || '').length;
    }
    // NO document.title. An SPA typically updates the title as part of the route change, before the
    // listing markup is swapped — so including it meant page CHROME changing counted as evidence the
    // listing had changed, which is the same mistake as trusting the pathname, one layer in.
    // Everything here is listing BODY content. (Codex review round 6, PR #1.)
    const main = document.querySelector('main') ?? document.body;
    return `${ldLength}|${main ? main.childElementCount : 0}|${
      document.querySelectorAll('img').length
    }`;
  }

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
      // NO initial quiet timer. Starting one meant an unchanged DOM satisfied the wait immediately:
      // the URL had already flipped to listing B while the DOM still held listing A, nothing had
      // mutated yet, and 300ms of that stillness read as "settled". We then extracted A under B's
      // identity — the mis-attribution this whole mechanism exists to prevent, arrived at by waiting
      // for the wrong thing. Settling now requires POSITIVE EVIDENCE that the page changed.
      // (Codex review round 3, PR #1.)
    });
  }

  async function measureCurrentPage({
    softNavigation = false,
    navDetectedAt = null,
    latencyUncertaintyMs = 0,
    signatureAtNav = null,
  } = {}) {
    const myGeneration = (generation += 1);

    let domSettled = true;
    if (softNavigation) {
      // Nothing may remain on screen while we wait — a panel from the previous listing on a page
      // that is no longer that listing is worse than an empty corner.
      unmountRecorder();
      // ALWAYS wait for the page to settle — a changed signature is treated as evidence that the
      // DOM moved, never as a reason to skip the wait.
      //
      // Skipping on a signature difference was wrong in both directions: a swap still in flight got
      // read half-finished, and any signal that changes early (the pathname, then the title) counted
      // as a completed transition. Waiting always, and accepting EITHER an observed mutation OR a
      // signature that has already moved, covers the fast navigation that finished before the poll
      // noticed it without trusting a weak signal about a document we can just watch instead.
      // (Codex review rounds 4 and 6, PR #1.)
      // Compared against the signature taken AT THE MOMENT NAVIGATION WAS DETECTED, not against the
      // last measured page. `lastSignature` could have drifted for reasons that had nothing to do
      // with this navigation — a lazy-loaded image, a price refresh on the page we were already on —
      // and any such drift read as "the new listing has arrived". The evidence has to be scoped to
      // the navigation it is being used to justify. (Codex review round 7, PR #1.)
      const baseline = signatureAtNav ?? lastSignature;
      const changedBeforeWeLooked = domSignature() !== baseline;
      const stability = await waitForStableDom();
      domSettled = stability.settled;
      // A newer navigation started while we waited; that one owns the page now.
      if (myGeneration !== generation) return;
      // Nothing mutated and nothing had already changed: whatever is on screen still belongs to the
      // previous listing, so measuring it would attribute that listing's reading to this one.
      if (!stability.mutated && !changedBeforeWeLooked) {
        // NOT a silent return. The page may be perfectly readable and simply slower than our
        // ceiling, and a person staring at an empty corner cannot tell that from "there was nothing
        // to find" — which is the same ambiguity the product's never-show-an-empty-panel rule
        // exists to prevent, reproduced in the instrument. Show the explicit unreadable state and
        // let the person decide. (Codex review round 7, PR #1.)
        mountRecorder({
          extraction: {
            result: { status: 'not_found', reason: 'page did not settle after navigation' },
            tiers: {
              tier1: { status: 'not_found' },
              tier2: { status: 'not_found' },
              tier3: { status: 'not_found' },
            },
            timing: { totalMs: 0, tier1Ms: 0, tier2Ms: 0, tier3Ms: 0 },
          },
          readyToPanelMs: null,
          onSave: async () => {},
        });
        return;
      }
    }

    // Captured AFTER the wait, so the URL and the DOM we are about to read belong to the same
    // moment as closely as we can establish.
    const capturedUrl = location.href;

    const extraction = runExtraction(document);
    lastSignature = domSignature();

    // The URL moved while we were extracting — this reading cannot be attributed to either page.
    if (location.href !== capturedUrl || myGeneration !== generation) return;

    // THE PANEL ALWAYS MOUNTS on a matched host. There is no longer a heuristic deciding which pages
    // are worth measuring, because every version of that heuristic suppressed the recorder on
    // exactly the pages where every extractor failed — which is the population we most need counted.
    // Skipping them makes them invisible to the sample, and invisible in a BIASED direction, since
    // pages we cannot classify correlate with pages we cannot read. The measured hit rate would have
    // come out higher than the truth, which is the one failure this phase cannot afford.
    //
    // The cost is that the panel also appears on search and help pages. That costs the person one
    // click on "Not a listing", which records nothing. A wasted click is recoverable; a silently
    // flattered headline number is not. (Codex review round 5, PR #1.)

    // Latency the user would actually feel: from the page being ready to the panel being on screen.
    // Only meaningful for the initial load — after a soft navigation there is no new navigation
    // entry, so it is reported as null rather than as a number that means something else.
    // Latency the person would actually feel, measured for BOTH kinds of navigation.
    //
    // This used to be null for every soft navigation, which the report then coerced to Infinity —
    // so every SPA navigation was classified over-budget and could never be a hit. On sites that are
    // SPAs, that is most of the sample: the headline number would have been driven down by a
    // measurement artifact and read as a product failure. (Codex review round 3, PR #1.)
    //
    // The two are measured from different origins and are NOT interchangeable, so which one this is
    // stays on the record.
    const nav = performance.getEntriesByType('navigation')[0];
    const isSoftNavigation = softNavigation;
    const readyToPanelMs = isSoftNavigation
      ? navDetectedAt == null
        ? null
        : Math.max(0, performance.now() - navDetectedAt)
      : nav
        ? Math.max(0, performance.now() - nav.domContentLoadedEventEnd)
        : null;

    mountRecorder({
      extraction,
      readyToPanelMs,
      capturedUrl,
      onSave: async ({ verdict, precisionVerdict, groundTruthRaw }) => {
        // "Not a listing" is a dismissal, not a datum — the page was never a measurement candidate,
        // so recording it would put non-listings in the denominator.
        if (verdict === 'not_a_listing') {
          unmountRecorder();
          return;
        }

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
          // Chosen from our own allowlist, not read off the page.
          site: siteLabelFor(location.hostname),
          // DATE ONLY, deliberately. A precise timestamp beside a site label is the makings of a
          // browsing log — "this person was on booking.com at 21:04". The report never groups by
          // time finer than a day, so the precision bought nothing and cost exactly that.
          // (Codex review round 5, PR #1.)
          recordedAt: new Date().toISOString().slice(0, 10),
          softNavigation: isSoftNavigation,
          // How late the navigation may have been NOTICED. A polled detection can be up to one
          // interval behind the real navigation, so the measured latency is an UNDER-estimate by up
          // to this much — which would let a panel that really took 1.2s be recorded inside an 800ms
          // budget and counted as a hit. The report adds this before comparing, so the budget is
          // judged on the worst case rather than the flattering one. (Codex review round 4, PR #1.)
          latencyUncertaintyMs: isSoftNavigation ? latencyUncertaintyMs : 0,
          // False when the DOM never went quiet within the ceiling. Such a reading is usable but
          // less trustworthy, and the report can exclude it rather than us pretending otherwise.
          domSettled,
          verdict,
          // What the person actually saw: whether the point is the building or a fuzzed area. The
          // extractor no longer guesses this, so it has to be observed.
          precisionVerdict: precisionVerdict ?? 'not_assessed',
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
  // Compared WITHOUT the fragment. A `#photos` link is not a new listing, but it fires hashchange —
  // which used to unmount the panel, wait out the full ceiling for a DOM change that had no reason
  // to happen, and then return having remounted nothing. The person was left with an empty corner on
  // a listing that read perfectly well. (Codex review round 6, PR #1.)
  const withoutFragment = (href) => href.split('#')[0];

  let lastUrl = withoutFragment(location.href);
  function onMaybeNavigated(latencyUncertaintyMs) {
    const current = withoutFragment(location.href);
    if (current === lastUrl) return;
    lastUrl = current;
    // Signature first: unmounting our own panel mutates the document, so reading it afterwards
    // would fold our own change into the evidence about the page's.
    const signatureBeforeUnmount = domSignature();
    // Clear immediately and synchronously — the wait happens inside measureCurrentPage, and the
    // previous listing's panel must not survive even that long.
    unmountRecorder();
    void measureCurrentPage({
      softNavigation: true,
      navDetectedAt: performance.now(),
      latencyUncertaintyMs,
      // Captured HERE, before any waiting, so the comparison is scoped to this navigation.
      signatureAtNav: signatureBeforeUnmount,
    });
  }
  // 250ms rather than 1000ms: the poll interval IS the latency measurement's error bar, so a slower
  // poll buys nothing and costs accuracy in the number this phase exists to produce.
  const POLL_MS = 250;
  setInterval(() => onMaybeNavigated(POLL_MS), POLL_MS);
  // These fire synchronously with the navigation, so a detection through them has no uncertainty.
  addEventListener('popstate', () => onMaybeNavigated(0));
  addEventListener('hashchange', () => onMaybeNavigated(0));
})();
