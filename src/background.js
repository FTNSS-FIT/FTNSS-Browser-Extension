// Service worker. Owns the per-tab reading.
//
// The content script does not write the reading to storage itself. It sends it here, and this file
// keys it by the sender's OWN tab id — a value the content script cannot choose, because it comes
// from `sender`, which the browser fills in. That is what binds a reading to the page it came from:
// with one global slot, two open tabs meant the popup showed, and could record, whichever page
// published last. (Codex review round 9, PR #1.)
//
// Readings live in session storage: transient by construction, gone when the browser closes. They
// are the only place an exact coordinate exists at all, and only until the popup has shown it.
//
// No network request is made anywhere in this file.

const key = (tabId) => `reading:${tabId}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Both checks matter. `sender.id` proves the message came from this extension rather than from a
  // page that found its way to our messaging channel; `sender.tab` proves it came from a content
  // script in a tab rather than from another extension surface. A content script lives inside a
  // hostile page and is never trusted for anything beyond "this is which tab I am in".
  if (sender.id !== chrome.runtime.id || sender.tab?.id == null) return false;
  if (message?.type !== 'FTNSS_READING') return false;

  chrome.storage.session
    .set({ [key(sender.tab.id)]: { ...message.reading, publishedAt: Date.now() } })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true; // response is async
});

// Don't leave readings for tabs that no longer exist.
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(key(tabId));
});
