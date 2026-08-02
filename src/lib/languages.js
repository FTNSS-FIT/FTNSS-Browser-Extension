// The languages FTNSS serves, in the site's own order and grouping.
//
// Copied from Consumer Web's `displayLanguages` in `src/i18n/config.ts` — extracted mechanically
// rather than retyped, because the last time a list was transcribed from that file by hand it came
// out 31 entries instead of 57 and quietly withheld links from 26 languages.
//
// ⚠️ `key` IS NOT `locale`, AND URLS MUST USE `locale`.
//
// One entry differs today: `en-US` displays as "English (US)" and routes to `en`. Building a url
// from `key` would produce `/en-US/book/gyms/…`, which is not a routable locale — and per the site's
// middleware it does not 404 cleanly, it becomes `/en/en-US/book/gyms/…` and 404s there, which
// reads as a broken deep link rather than a bad language choice.
//
// Consumer Web warned this affected four entries; measured against `origin/main` it is one. The
// advice stands either way, and the narrower exposure is worth knowing rather than assuming.

/** @typedef {{ key: string, locale: string, name: string, flag: string, group?: string }} DisplayLanguage */

/** Ordered exactly as the site orders them. Group comments mark the site's own boundaries. */
export const DISPLAY_LANGUAGES = Object.freeze([
  // English
  { key: 'en-CA', locale: 'en-CA', name: 'English (Canada)', flag: '🇨🇦' },
  { key: 'en-US', locale: 'en', name: 'English (US)', flag: '🇺🇸' },
  { key: 'en-GB', locale: 'en-GB', name: 'English (UK)', flag: '🇬🇧' },
  { key: 'en-AU', locale: 'en-AU', name: 'English (AU)', flag: '🇦🇺' },
  // French
  { key: 'fr', locale: 'fr', name: 'Français', flag: '🇫🇷' },
  { key: 'fr-CA', locale: 'fr-CA', name: 'Français (Canada)', flag: '🇨🇦' },
  // Romance languages
  { key: 'es', locale: 'es', name: 'Español', flag: '🇪🇸' },
  { key: 'es-MX', locale: 'es-MX', name: 'Español (México)', flag: '🇲🇽' },
  { key: 'pt', locale: 'pt', name: 'Português', flag: '🇧🇷' },
  { key: 'pt-PT', locale: 'pt-PT', name: 'Português (Portugal)', flag: '🇵🇹' },
  { key: 'it', locale: 'it', name: 'Italiano', flag: '🇮🇹' },
  // Other European
  { key: 'de', locale: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { key: 'nl', locale: 'nl', name: 'Nederlands', flag: '🇳🇱' },
  { key: 'pl', locale: 'pl', name: 'Polski', flag: '🇵🇱' },
  { key: 'sv', locale: 'sv', name: 'Svenska', flag: '🇸🇪' },
  { key: 'da', locale: 'da', name: 'Dansk', flag: '🇩🇰' },
  { key: 'el', locale: 'el', name: 'Ελληνικά', flag: '🇬🇷' },
  { key: 'ru', locale: 'ru', name: 'Русский', flag: '🇷🇺' },
  { key: 'uk', locale: 'uk', name: 'Українська', flag: '🇺🇦' },
  // European — v3 expansion (Stripe-payout countries + Catalan/Serbian)
  { key: 'ca', locale: 'ca', name: 'Català', flag: '🇪🇸' },
  { key: 'nb', locale: 'nb', name: 'Norsk', flag: '🇳🇴' },
  { key: 'fi', locale: 'fi', name: 'Suomi', flag: '🇫🇮' },
  { key: 'cs', locale: 'cs', name: 'Čeština', flag: '🇨🇿' },
  { key: 'sk', locale: 'sk', name: 'Slovenčina', flag: '🇸🇰' },
  { key: 'sl', locale: 'sl', name: 'Slovenščina', flag: '🇸🇮' },
  { key: 'hu', locale: 'hu', name: 'Magyar', flag: '🇭🇺' },
  { key: 'ro', locale: 'ro', name: 'Română', flag: '🇷🇴' },
  { key: 'bg', locale: 'bg', name: 'Български', flag: '🇧🇬' },
  { key: 'hr', locale: 'hr', name: 'Hrvatski', flag: '🇭🇷' },
  { key: 'sr', locale: 'sr', name: 'Српски', flag: '🇷🇸' },
  { key: 'et', locale: 'et', name: 'Eesti', flag: '🇪🇪' },
  { key: 'lv', locale: 'lv', name: 'Latviešu', flag: '🇱🇻' },
  { key: 'lt', locale: 'lt', name: 'Lietuvių', flag: '🇱🇹' },
  { key: 'ga', locale: 'ga', name: 'Gaeilge', flag: '🇮🇪' },
  { key: 'mt', locale: 'mt', name: 'Malti', flag: '🇲🇹' },
  // Middle East & South Asia
  { key: 'ar', locale: 'ar', name: 'العربية', flag: '🇦🇪' },
  { key: 'fa', locale: 'fa', name: 'فارسی', flag: '🇮🇷' },
  { key: 'he', locale: 'he', name: 'עברית', flag: '🇮🇱' },
  { key: 'ur', locale: 'ur', name: 'اردو', flag: '🇵🇰' },
  { key: 'hi', locale: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
  { key: 'bn', locale: 'bn', name: 'বাংলা', flag: '🇧🇩' },
  { key: 'ta', locale: 'ta', name: 'தமிழ்', flag: '🇱🇰' },
  { key: 'pa', locale: 'pa', name: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  { key: 'te', locale: 'te', name: 'తెలుగు', flag: '🇮🇳' },
  { key: 'mr', locale: 'mr', name: 'मराठी', flag: '🇮🇳' },
  { key: 'gu', locale: 'gu', name: 'ગુજરાતી', flag: '🇮🇳' },
  // East & Southeast Asia
  { key: 'zh', locale: 'zh', name: '中文 (简体)', flag: '🇨🇳' },
  { key: 'zh-Hant', locale: 'zh-Hant', name: '繁體中文', flag: '🇹🇼' },
  { key: 'ja', locale: 'ja', name: '日本語', flag: '🇯🇵' },
  { key: 'ko', locale: 'ko', name: '한국어', flag: '🇰🇷' },
  { key: 'tr', locale: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { key: 'th', locale: 'th', name: 'ไทย', flag: '🇹🇭' },
  { key: 'vi', locale: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' },
  { key: 'id', locale: 'id', name: 'Bahasa Indonesia', flag: '🇮🇩' },
  { key: 'ms', locale: 'ms', name: 'Bahasa Melayu', flag: '🇲🇾' },
  { key: 'tl', locale: 'tl', name: 'Tagalog', flag: '🇵🇭' },
  // Africa
  { key: 'sw', locale: 'sw', name: 'Kiswahili', flag: '🇰🇪' },
].map(Object.freeze));

/**
 * The list with one language hoisted to the front.
 *
 * Copies the affordance `StarkWelcomeModal` already uses rather than inventing a shortlist: one
 * obviously-right option first, everything else in the site's stable order behind it. A hand-picked
 * "top 6" would be a second opinion about which languages matter, maintained separately from the
 * site's, and drifting from it.
 */
export function languagesWithFirst(locale) {
  const first = DISPLAY_LANGUAGES.filter((l) => l.locale === locale);
  const rest = DISPLAY_LANGUAGES.filter((l) => l.locale !== locale);
  return [...first, ...rest];
}

/** The display entry for a routable locale, or null. */
export function languageFor(locale) {
  return DISPLAY_LANGUAGES.find((l) => l.locale === locale) ?? null;
}
