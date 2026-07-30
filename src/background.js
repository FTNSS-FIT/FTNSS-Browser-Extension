// Minimal service worker. One job.
//
// The current page's reading lives in chrome.storage.session — transient by construction, gone when
// the browser closes — because it is the only place exact coordinates exist at all, and they exist
// only long enough for the popup to display them and compute a distance. Session storage is not
// readable from a content script unless a trusted context says so, which is what this does.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
