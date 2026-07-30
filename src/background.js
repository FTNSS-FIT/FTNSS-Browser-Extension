// Service worker. Owns the per-tab reading, and is the trust boundary in front of it.
//
// A content script runs inside a hostile page. It is trusted for exactly one thing — being able to
// say which tab it is in, and only because that comes from `sender`, which the browser fills in and
// the script cannot choose. Everything else it sends is a claim to be checked.
//
// So this file does not store what it is given: it VALIDATES and REBUILDS. Every field is checked
// for type, range and membership of a known set, and the stored object is constructed here from an
// allowlist. Spreading `message.reading` into storage was the defect — a malformed or
// page-influenced payload could put arbitrary strings into fields that later reach an exported file,
// or numbers that make the popup throw while rendering. (Codex review round 10, PR #1.)
//
// Readings live in session storage: transient by construction, gone when the browser closes. They
// are the only place an exact coordinate exists at all, and only until the popup has shown it.
//
// No network request is made anywhere in this file.

const key = (tabId) => `reading:${tabId}`;

const TIER_STATUSES = new Set(['found', 'found_address', 'not_found']);
const RESULT_STATUSES = new Set(['found', 'found_address', 'not_found']);
const PRECISIONS = new Set(['approximate', 'unknown', null]);

const finiteInRange = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Durations we are willing to believe. Anything else is a bug or a lie; either way, drop it. */
const asDuration = (value) => (finiteInRange(value, 0, 600_000) ? value : null);

function validateResult(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  if (!RESULT_STATUSES.has(raw.status)) return null;

  const result = {
    status: raw.status,
    tier: [1, 2, 3].includes(raw.tier) ? raw.tier : null,
    precision: PRECISIONS.has(raw.precision ?? null) ? raw.precision ?? null : null,
  };

  if (raw.status === 'found') {
    // A "found" without a usable coordinate is not a found. Refusing it here means the popup can
    // call `result.lat.toFixed(...)` without a guard, rather than that guard being one more place
    // for someone to forget.
    if (!finiteInRange(raw.lat, -90, 90) || !finiteInRange(raw.lon, -180, 180)) return null;
    result.lat = raw.lat;
    result.lon = raw.lon;
  }
  return result;
}

function validateReading(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const tiers = raw.tiers ?? {};
  const timing = raw.timing ?? {};
  const tier = (value) => (TIER_STATUSES.has(value) ? value : 'not_found');

  return {
    result: validateResult(raw.result) ?? { status: 'not_found', tier: null, precision: null },
    tiers: { tier1: tier(tiers.tier1), tier2: tier(tiers.tier2), tier3: tier(tiers.tier3) },
    timing: {
      totalMs: asDuration(timing.totalMs),
      readingReadyMs: asDuration(timing.readingReadyMs),
    },
    provisional: raw.provisional === true,
    softNavigation: raw.softNavigation === true,
    domSettled: raw.domSettled !== false,
    latencyUncertaintyMs: asDuration(raw.latencyUncertaintyMs) ?? 0,
    // Kept for ONE purpose: warning the operator in the popup when it disagrees with the cohort
    // they declared. It is never written into a saved record — see lib/storage.js.
    detectedSite:
      typeof raw.detectedSite === 'string' && raw.detectedSite.length <= 40 ? raw.detectedSite : 'other',
  };
}

// A reading must not outlive the page it describes — AND THE STATE THAT ENFORCES THAT MUST NOT
// OUTLIVE THE WORKER EITHER.
//
// All of this lived in module-scope Map and Set objects. An MV3 service worker is terminated after a
// short idle period and restarted on the next event, so those vanished — while readings, which live
// in session storage, did not. After a restart an old document's in-flight reading could be accepted
// against an empty high-water mark, overwrite the new page's reading, and then raise the mark so the
// NEW document's readings were rejected. Every navigation guard added over five rounds evaporated on
// a timer, and the failure mode was the exact one they were built to prevent.
//
// The state now lives in session storage alongside the readings it governs, so the two are lost and
// kept together. (Codex review round 19, PR #1.)
const STATE_KEY = 'phase1_navstate';

async function loadState() {
  const bag = await chrome.storage.session.get(STATE_KEY);
  const state = bag?.[STATE_KEY];
  return state && typeof state === 'object' ? state : {};
}

async function tabState(tabId) {
  const state = await loadState();
  return state[tabId] ?? { navigationId: 0, activeDocumentId: null, seqByDoc: {}, invalidated: [] };
}

async function writeTabState(tabId, next) {
  const state = await loadState();
  state[tabId] = next;
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function dropTabState(tabId) {
  const state = await loadState();
  delete state[tabId];
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

/**
 * Drop a tab's reading.
 *
 * `blacklistDocument` is the whole distinction, and getting it wrong broke the harness outright once.
 *
 * A SOFT navigation keeps the SAME document — that is what same-document navigation means — so
 * blacklisting the document on a soft invalidate blacklisted the very document about to publish the
 * replacement. Every subsequent listing then went unmeasured, on two sites that are both single-page
 * applications. Blacklisting is only correct for a FULL navigation, where the old document is
 * genuinely gone and anything still in flight from it is stale by definition.
 */
async function invalidateTab(tabId, { blacklistDocument }) {
  const state = await tabState(tabId);
  state.navigationId += 1;
  if (blacklistDocument) {
    if (state.activeDocumentId != null) {
      // Bounded: it only needs to outlive messages already in flight, which is milliseconds.
      state.invalidated = [...state.invalidated, state.activeDocumentId].slice(-20);
    }
    state.activeDocumentId = null;
    state.seqByDoc = {};
  }
  await writeTabState(tabId, state);
  await chrome.storage.session.remove(key(tabId));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // `sender.id` proves this came from our own extension rather than from a page that found the
  // channel. `sender.tab` proves it came from a content script in a tab. `frameId === 0` rejects
  // sub-frames, so a hostile page cannot iframe a real listing and publish a reading for it as
  // though it described the top-level page the operator is looking at.
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab?.id == null || sender.frameId !== 0) return false;
  if (message?.type !== 'FTNSS_READING' && message?.type !== 'FTNSS_INVALIDATE') return false;

  handleMessage(message, sender)
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true; // every path is async now that the state is in storage
});

async function handleMessage(message, sender) {
  const tabId = sender.tab.id;
  const documentId = sender.documentId ?? null;
  const state = await tabState(tabId);

  // Document checks run FIRST, for invalidation as well as publication. A guard that runs after the
  // thing it guards is not a guard: a delayed invalidate from a superseded document could otherwise
  // delete the replacement document's reading.
  if (documentId != null && state.invalidated.includes(documentId)) return false;

  // Sequences are scoped PER DOCUMENT. A fresh document starts its own count, so a high-water mark
  // left by the previous one cannot reject every reading the new one publishes.
  const docKey = documentId ?? 'unknown';
  const seq = message.seq;
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  if (seq < (state.seqByDoc[docKey] ?? 0)) return false;
  state.seqByDoc = { ...state.seqByDoc, [docKey]: seq };

  if (message.type === 'FTNSS_INVALIDATE') {
    // A soft navigation: same document, so the document itself stays welcome.
    await writeTabState(tabId, state);
    await invalidateTab(tabId, { blacklistDocument: false });
    return true;
  }

  const reading = validateReading(message.reading);
  if (reading == null) return false;

  state.activeDocumentId = documentId;
  await writeTabState(tabId, state);

  await chrome.storage.session.set({
    [key(tabId)]: {
      ...reading,
      publishedAt: Date.now(),
      documentId,
      seq,
      navigationId: state.navigationId,
    },
  });
  return true;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // `loading` fires for every top-level navigation, including one leaving our site list entirely.
  // It needs no host permission, which is the point: the alternative signals all do.
  if (changeInfo.status !== 'loading') return;
  // A full navigation: the old document is gone, so its late messages are stale by definition.
  void invalidateTab(tabId, { blacklistDocument: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(key(tabId));
  void dropTabState(tabId);
});
