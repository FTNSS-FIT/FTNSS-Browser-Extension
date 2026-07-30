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
    softNavigation: raw.softNavigation === true,
    domSettled: raw.domSettled !== false,
    latencyUncertaintyMs: asDuration(raw.latencyUncertaintyMs) ?? 0,
    // Kept for ONE purpose: warning the operator in the popup when it disagrees with the cohort
    // they declared. It is never written into a saved record — see lib/storage.js.
    detectedSite:
      typeof raw.detectedSite === 'string' && raw.detectedSite.length <= 40 ? raw.detectedSite : 'other',
  };
}

// A reading must not outlive the page it describes.
//
// It used to be removed only when the tab closed or a verdict was recorded — so navigating from
// listing A to listing B, or away to a site with no content script at all, left A's reading in place
// and the popup presented it as "Current page". A verdict then attached A's coordinates to a page
// the person was looking at but had never measured. Nothing could notice, because the only component
// that knew a navigation had happened was the content script that no longer ran.
// (Codex review round 10, PR #1.)
const navigationIds = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // `sender.id` proves this came from our own extension rather than from a page that found the
  // channel. `sender.tab` proves it came from a content script in a tab. `frameId === 0` rejects
  // sub-frames, so a hostile page cannot iframe a real listing and publish a reading for it as
  // though it described the top-level page the operator is looking at.
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab?.id == null || sender.frameId !== 0) return false;
  if (message?.type !== 'FTNSS_READING') return false;

  const reading = validateReading(message.reading);
  if (reading == null) return false;

  chrome.storage.session
    .set({
      [key(sender.tab.id)]: {
        ...reading,
        publishedAt: Date.now(),
        // The navigation this reading belongs to. The popup refuses one whose generation is not the
        // tab's current generation.
        navigationId: navigationIds.get(sender.tab.id) ?? 0,
      },
    })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true; // response is async
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // `loading` fires for every top-level navigation, including one leaving our site list entirely.
  // It needs no host permission, which is the point: the alternative signals all do.
  if (changeInfo.status !== 'loading') return;
  navigationIds.set(tabId, (navigationIds.get(tabId) ?? 0) + 1);
  void chrome.storage.session.remove(key(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navigationIds.delete(tabId);
  void chrome.storage.session.remove(key(tabId));
});
