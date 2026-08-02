// What the person has chosen: language, and whether the measurement tools are on show.
//
// SEPARATE FROM THE MEASUREMENT RECORDS on purpose. Those are a research artifact that gets
// exported and cleared; these are settings that should survive a "Clear all". Storing them in the
// same bag is how a preference gets wiped by a button that promised to delete measurements.

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locale.js';

const KEY = 'ftnss.prefs';

const DEFAULTS = Object.freeze({
  locale: DEFAULT_LOCALE,
  // OFF by default, and that is the point of this whole change: what ships to a user is the gym
  // panel. The measurement harness is ours, it is still needed for phase 1, and it should not be
  // the first thing anybody sees.
  devMode: false,
});

/** Rebuilt field by field — a stored blob from an older build must not widen what this returns. */
export async function loadPrefs() {
  let stored;
  try {
    stored = (await chrome.storage.local.get(KEY))?.[KEY];
  } catch {
    return { ...DEFAULTS };
  }
  if (stored == null || typeof stored !== 'object') return { ...DEFAULTS };
  return {
    // An unsupported locale falls back rather than being carried: a locale we cannot confirm the
    // site serves produces a link that 404s, and one stored months ago is exactly the kind that
    // stops being served without anybody noticing here.
    locale: SUPPORTED_LOCALES.includes(stored.locale) ? stored.locale : DEFAULTS.locale,
    devMode: stored.devMode === true,
  };
}

export async function savePrefs(patch) {
  const next = { ...(await loadPrefs()), ...patch };
  const clean = {
    locale: SUPPORTED_LOCALES.includes(next.locale) ? next.locale : DEFAULTS.locale,
    devMode: next.devMode === true,
  };
  await chrome.storage.local.set({ [KEY]: clean });
  return clean;
}
