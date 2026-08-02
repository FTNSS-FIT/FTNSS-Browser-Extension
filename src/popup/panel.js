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

import { gymsNear } from '../lib/proximity.js';
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
  bar.appendChild(el('div', 'FTNSS', 'wordmark'));

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

  body.replaceChildren();
  body.appendChild(el('div', `${answer.gyms.length} nearest`, 'label'));

  for (const gym of answer.gyms) {
    const href = gymUrl(gym.path, endpoint, prefs.locale);
    // A row, not a card. Anchor when we can build a safe url, plain div when we cannot — never a
    // guessed link, for the reasons in locale.js.
    const row = el(href == null ? 'div' : 'a', null, 'gym-row');
    if (href != null) {
      row.href = href;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
    }
    row.appendChild(el('div', gym.name, 'gym-name'));
    if (gym.city) row.appendChild(el('div', gym.city, 'label'));
    body.appendChild(row);
  }

  // NO DISTANCES. The query point is a 250m cell, so any figure would claim precision the search
  // never had — four attempts at wording it failed before deleting it was the honest answer. The
  // ordering carries what matters and survives the uncertainty. (docs/DECISIONS.md.)
  body.appendChild(el('div', 'Ordered nearest first, from an approximate location.', 'fineprint'));
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
