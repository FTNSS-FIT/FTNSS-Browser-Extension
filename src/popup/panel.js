// The panel a user sees. The measurement harness is the other file, and it is now the exception
// rather than the default.
//
// WHY THIS EXISTS SEPARATELY. `popup.js` grew as an instrument: it shows tiers, timings, reasons,
// and asks the operator to verify readings. Every one of those is right for us and wrong for
// someone looking at a hotel. Rather than add branches to it, the two are separate modules with a
// switch at the top — so nothing a user sees can accidentally inherit an instrument's affordances,
// and the harness stays as blunt as it needs to be.
//
// Composition follows Consumer Web's gym card, deliberately: distance first, name second,
// availability and price last. That ordering is what a person recognises, and two different
// treatments of "a gym near you" across our own products is a worse outcome than a plainer panel.
// What is NOT ported is its geometry — that card is a 5:7 poster tile with a full-bleed photo, and
// at 360px wide it does not survive the translation. Rows instead.

import { gymsNear, describeDistance } from '../lib/proximity.js';
import { gymUrl } from '../lib/locale.js';
import { DISPLAY_LANGUAGES, languagesWithFirst, languageFor } from '../lib/languages.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';
import { loadEndpoint, readActivePage } from '../lib/storage.js';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};

/** One at a time, and cancel the old one — same reasoning as the harness. */
let generation = 0;
let inFlight = null;

/**
 * The pass kinds offered as filters, in the platform's canonical order.
 *
 * KEYED ON KIND, NOT A DAY COUNT. `days` is not a field the consumer path reads; `kind` is what the
 * site, mobile and partner all filter on, and keying on days had this extension filtering by a
 * column the rest of the platform ignores.
 *
 * All six ship, including the two that may have no inventory near any given search. `weekend` is
 * the 3-day pass. `quarter` is the 90-day one and exists for a legal reason rather than a product
 * one — Pennsylvania caps prepaid membership contracts at three months, so it is how a PA gym sells
 * anything longer than a month, and there is a live PA gym. Removing a filter because a query
 * returned no rows would have deleted the mechanism keeping a whole state sellable.
 *
 * Availability is derived from the RESPONSE, never from this list, so a kind with nothing behind it
 * greys out and lights up again on its own. That is what let a wrong inventory reading pass through
 * without reaching a user. (docs/DECISIONS.md 18.)
 */
const PASS_KINDS = Object.freeze([
  { kind: 'day', label: 'Day' },
  { kind: 'weekend', label: '3 day' },
  { kind: 'week', label: 'Week' },
  { kind: 'month', label: 'Month' },
  { kind: 'quarter', label: '90 day' },
  { kind: 'year', label: 'Year' },
]);

const PASS_LABEL = new Map(PASS_KINDS.map((p) => [p.kind, p.label]));

/** Not persisted: a filter is about this search, not a standing preference. */
let selectedKind = null;
let openNowOnly = false;

/** The cheapest pass of a given kind, for the price line. */
function cheapest(gym, kind) {
  const candidates = (gym.passes ?? []).filter((p) => kind == null || p.kind === kind);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.price < a.price ? b : a));
}

function matchesFilters(gym) {
  if (openNowOnly && gym.hours?.open !== true) return false;
  if (selectedKind != null && !(gym.passes ?? []).some((p) => p.kind === selectedKind)) return false;
  return true;
}

function formatPrice(pass) {
  if (pass == null) return null;
  // Intl handles the currency symbol and placement; a hand-rolled "$" is wrong the moment a gym
  // prices in anything but dollars, and we already have both CAD and USD live.
  try {
    const money = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: pass.currency,
      maximumFractionDigits: 2,
    }).format(pass.price);
    return `${money} · ${(PASS_LABEL.get(pass.kind) ?? pass.kind).toLowerCase()} pass`;
  } catch {
    return `${pass.price} ${pass.currency} · ${(PASS_LABEL.get(pass.kind) ?? pass.kind).toLowerCase()} pass`;
  }
}

function hoursLine(gym) {
  const hours = gym.hours;
  if (hours == null) return null;
  const line = el('div', null, hours.open ? 'hours' : 'hours closed');
  line.appendChild(el('span', '', 'open-dot'));
  const window = hours.opensAt && hours.closesAt ? `${hours.opensAt}–${hours.closesAt}` : null;
  line.appendChild(
    document.createTextNode(
      hours.open
        ? (window ? `Open now · til ${hours.closesAt}` : 'Open now')
        : (window ? `Closed · ${window} today` : 'Closed today'),
    ),
  );
  return line;
}

export async function renderPanel(root) {
  const mine = (generation += 1);
  const stale = () => mine !== generation;
  inFlight?.abort();

  const prefs = await loadPrefs();
  if (stale()) return;

  root.replaceChildren();
  root.appendChild(header(root, prefs));

  const body = el('div', null, 'panel-body');
  root.appendChild(body);
  body.appendChild(el('div', 'Nothing has been sent yet.', 'label'));

  const find = el('button', 'Find gyms near this stay', 'primary block');
  find.addEventListener('click', () => void search(root, body, prefs));
  body.appendChild(find);

  body.appendChild(
    el(
      'div',
      'Looking up gyms sends one coordinate rounded to a 250m grid. Nothing about the page you are on.',
      'fineprint',
    ),
  );
}

function header(root, prefs) {
  const bar = el('div', null, 'panel-header');
  // THE ACTUAL MARK, not the letters typed out. The icon set already ships for the toolbar, so
  // this costs nothing and is the difference between looking like FTNSS and spelling it.
  const brand = el('div', null, 'brand');
  const logo = document.createElement('img');
  logo.src = '../icons/icon-48.png';
  logo.alt = 'FTNSS';
  brand.appendChild(logo);
  brand.appendChild(el('div', 'Nearby gyms', 'wordmark'));
  bar.appendChild(brand);

  const right = el('div', null, 'header-actions');
  const language = languageFor(prefs.locale);
  const lang = el('button', `${language?.flag ?? ''} ${language?.key ?? prefs.locale}`.trim(), 'ghost');
  lang.title = 'Language';
  lang.addEventListener('click', () => void renderLanguages(root, prefs));
  right.appendChild(lang);

  const gear = el('button', 'Settings', 'ghost');
  gear.addEventListener('click', () => void renderPreferences(root, prefs));
  right.appendChild(gear);

  bar.appendChild(right);
  return bar;
}

async function search(root, body, prefs) {
  const mine = generation;
  const stale = () => mine !== generation;

  const endpoint = await loadEndpoint();
  const say = (message, className = 'state') => {
    if (stale()) return;
    body.replaceChildren(el('div', message, className));
    const again = el('button', 'Try again', 'block');
    again.addEventListener('click', () => void search(root, body, prefs));
    body.appendChild(again);
  };

  if (endpoint == null) {
    say('FTNSS gym search is not switched on in this build yet.');
    return;
  }

  const reading = await readActivePage({ attempts: 30, intervalMs: 300 });
  if (stale()) return;
  const result = reading?.result;

  if (result?.status !== 'found') {
    // The two failures mean opposite things and must not read alike: "we could not work out where
    // this stay is" is about us, "no gyms near here" is about our coverage. Conflating them is how
    // a coverage problem gets mistaken for a broken extension, and vice versa.
    say(
      result?.status === 'found_address'
        ? 'This page gives an address but no map location, so we cannot search from it yet.'
        : 'We could not work out where this stay is. Open a listing page and try again.',
    );
    return;
  }

  body.replaceChildren(el('div', 'Searching…', 'state'));

  const controller = new AbortController();
  inFlight = controller;
  const answer = await gymsNear({ lat: result.lat, lon: result.lon }, { endpoint, signal: controller.signal });
  if (stale()) return;

  if (answer.status === 'error') return say('Could not reach FTNSS. Try again in a moment.');
  if (answer.status === 'unconfigured') return say('FTNSS gym search is not switched on in this build yet.');
  if (answer.status === 'empty') {
    say(
      result.precision === 'approximate'
        ? 'No FTNSS gyms found near here — though this page only gives an approximate location, so it is worth checking on the site.'
        : 'No FTNSS gyms found near this stay yet.',
    );
    return;
  }

  // Kept so the filters can re-render without a second request. Filtering is a view over one
  // answer, not a reason to ask again — each search is a network call and a coordinate leaving the
  // browser, and neither should happen because someone tapped a chip.
  renderResults(root, body, prefs, answer.gyms, result, endpoint);
}

function renderResults(root, body, prefs, gyms, result, endpoint) {
  body.replaceChildren();

  // --- filters -------------------------------------------------------------------------------
  const filters = el('div', null, 'filters');

  const openNow = el('button', 'Open now', 'chip');
  openNow.setAttribute('aria-pressed', String(openNowOnly));
  // Disabled when the server sent no hours at all — a filter that cannot work should say so rather
  // than silently returning everything and looking broken.
  const anyHours = gyms.some((g) => g.hours != null);
  if (!anyHours) openNow.disabled = true;
  openNow.addEventListener('click', () => {
    openNowOnly = !openNowOnly;
    renderResults(root, body, prefs, gyms, result, endpoint);
  });
  filters.appendChild(openNow);

  for (const pass of PASS_KINDS) {
    const available = gyms.some((g) => (g.passes ?? []).some((p) => p.kind === pass.kind));
    const chip = el('button', pass.label, 'chip');
    chip.setAttribute('aria-pressed', String(selectedKind === pass.kind));
    if (!available) {
      chip.disabled = true;
      chip.title = 'No gym near here sells this pass';
    }
    chip.addEventListener('click', () => {
      selectedKind = selectedKind === pass.kind ? null : pass.kind;
      renderResults(root, body, prefs, gyms, result, endpoint);
    });
    filters.appendChild(chip);
  }
  body.appendChild(filters);

  // --- rows ----------------------------------------------------------------------------------
  const shown = gyms.filter(matchesFilters);

  if (shown.length === 0) {
    body.appendChild(
      el(
        'div',
        openNowOnly && selectedKind != null
          ? 'No gym near here is open now with that pass.'
          : openNowOnly
            ? 'No gym near here is open right now.'
            : 'No gym near here sells that pass.',
        'state',
      ),
    );
    body.appendChild(el('div', `${gyms.length} nearby before filtering.`, 'fineprint'));
    return;
  }

  body.appendChild(el('div', `${shown.length} of ${gyms.length} nearby`, 'label'));

  for (const gym of shown) {
    const href = gymUrl(gym.path, endpoint, prefs.locale);
    const row = el(href == null ? 'div' : 'a', null, 'gym-row');
    if (href != null) {
      row.href = href;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
    }

    const top = el('div', null, 'gym-top');
    top.appendChild(el('div', gym.name, 'gym-name'));
    // DISTANCE IS BACK, and it is worded as an approximation everywhere it appears — see
    // describeDistance and DECISIONS 17 for why it was removed and why it returned.
    const distance = describeDistance(gym.distanceMetres);
    if (distance) top.appendChild(el('div', distance, 'distance'));
    row.appendChild(top);

    const meta = el('div', null, 'gym-meta');
    const price = formatPrice(cheapest(gym, selectedKind));
    if (price) meta.appendChild(el('div', price, 'price'));
    const hours = hoursLine(gym);
    if (hours) meta.appendChild(hours);
    if (gym.city) meta.appendChild(el('div', gym.city, 'label'));
    if (meta.children.length > 0) row.appendChild(meta);

    body.appendChild(row);
  }

  body.appendChild(
    el(
      'div',
      result.precision === 'approximate'
        ? 'Distances are rough — this page gives only an approximate location.'
        : 'Distances are approximate: measured from a point rounded to a 250m grid.',
      'fineprint',
    ),
  );
}

async function renderLanguages(root, prefs) {
  root.replaceChildren();
  const bar = el('div', null, 'panel-header');
  bar.appendChild(el('div', 'Language', 'wordmark'));
  const back = el('button', 'Back', 'ghost');
  back.addEventListener('click', () => void renderPanel(root));
  bar.appendChild(back);
  root.appendChild(bar);

  const body = el('div', null, 'panel-body scroll');
  root.appendChild(body);

  // The site's own order, with the current choice hoisted — the affordance StarkWelcomeModal uses.
  // A hand-picked "top 6" would be a second opinion about which languages matter, maintained
  // separately from the site's and drifting from it.
  for (const language of languagesWithFirst(prefs.locale)) {
    const row = el('button', null, 'language-row');
    row.appendChild(el('span', language.flag, 'flag'));
    row.appendChild(el('span', language.name, 'language-name'));
    if (language.locale === prefs.locale) row.appendChild(el('span', 'Selected', 'label'));
    row.addEventListener('click', async () => {
      // `.locale`, NEVER `.key` — see languages.js. `en-US` is a display key that routes to `en`.
      await savePrefs({ locale: language.locale });
      await renderPanel(root);
    });
    body.appendChild(row);
  }
}

async function renderPreferences(root, prefs) {
  root.replaceChildren();
  const bar = el('div', null, 'panel-header');
  bar.appendChild(el('div', 'Settings', 'wordmark'));
  const back = el('button', 'Back', 'ghost');
  back.addEventListener('click', () => void renderPanel(root));
  bar.appendChild(back);
  root.appendChild(bar);

  const body = el('div', null, 'panel-body');
  root.appendChild(body);

  const language = languageFor(prefs.locale);
  body.appendChild(el('div', 'Language', 'label'));
  const langButton = el('button', `${language?.flag ?? ''} ${language?.name ?? prefs.locale}`.trim(), 'block');
  langButton.addEventListener('click', () => void renderLanguages(root, prefs));
  body.appendChild(langButton);
  body.appendChild(
    el('div', `${DISPLAY_LANGUAGES.length} languages. Gym pages open in the one you choose.`, 'fineprint'),
  );

  body.appendChild(el('hr'));

  body.appendChild(el('div', 'Privacy', 'label'));
  body.appendChild(
    el(
      'div',
      'This extension reads a page only when you press a button, and never stores or sends anything ' +
      'about it. Searching sends one coordinate rounded to a 250m grid — enough to find gyms in the ' +
      'area, not enough to identify where you are staying.',
      'fineprint',
    ),
  );

  body.appendChild(el('hr'));

  // The harness, behind a switch, described honestly rather than hidden. Someone who turns this on
  // should know what it is for; someone who does not should never meet it.
  body.appendChild(el('div', 'Developer', 'label'));
  const toggle = el('button', prefs.devMode ? 'Measurement tools: on' : 'Measurement tools: off', 'block');
  toggle.addEventListener('click', async () => {
    await savePrefs({ devMode: !prefs.devMode });
    // A full reload, because the two views are separate modules chosen at startup. Cheap, and it
    // avoids the class of bug where a mode switch leaves half the previous view behind.
    location.reload();
  });
  body.appendChild(toggle);
  body.appendChild(
    el(
      'div',
      'Shows the phase-1 measurement harness: what each extraction tier found, timings, and the ' +
      'controls for recording readings. Internal tooling, not part of the product.',
      'fineprint',
    ),
  );
}
