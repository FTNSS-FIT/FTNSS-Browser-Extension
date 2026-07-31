# Architecture

For FTNSS staff and anyone reading the code. What this is, how it runs, how it fits with the rest of
the platform, and what it would take to ship it on each browser.

## What it is, in one paragraph

A browser extension that reads a hotel or rental listing's location **from the page you are already
looking at**, in your own browser, and shows which FTNSS gyms are nearby. It is a discovery surface
that hands off to ftnss.fit to buy. It is not a checkout, it holds no account, and it never tells us
what you were looking at.

**Right now this repository contains the phase 1 measurement harness, not the product.** The harness
exists to answer one question before anyone builds the product: how often can a listing page's
location actually be read, correctly and fast enough to matter? See
[`docs/PHASE-1-MEASUREMENT.md`](docs/PHASE-1-MEASUREMENT.md).

## The stack, plainly

| | |
|---|---|
| **Language** | Plain JavaScript. ES modules. No TypeScript |
| **Dependencies** | **None.** Zero runtime, zero build-time |
| **Build step** | **None.** It loads unpacked, exactly as written |
| **Framework** | None. The UI is ~200 lines of DOM calls |
| **Tests** | Node's built-in test runner. `npm test` |
| **Size** | ~1,300 lines across 10 files |

Those are deliberate choices, not things nobody got round to. A dependency tree is an extension's
attack surface, and it is also source that a sceptical reader has to audit before believing the
privacy claim — the whole point of publishing this. "No build step" means what runs in the browser is
byte-for-byte what is in the repository, which is the strongest possible version of a reproducible
build.

## How it runs

Three pieces, and the split between them is the most important design decision here.

```
  ┌──────────────────────────┐   FTNSS_READ    ┌────────────────────┐
  │ content script           │ ◄────────────── │ popup (the UI)     │
  │ src/content.js           │ ──────────────► │ src/popup/*        │
  │ runs INSIDE the page     │    reading      │ browser-owned      │
  └──────────────────────────┘                 └────────────────────┘
             │                                            │
             ▼ reads DOM only                             ▼ writes
  ┌──────────────────────────┐                 ┌────────────────────┐
  │ extractors               │                 │ chrome.storage     │
  │ src/extract/*            │                 │ (verdicts only)    │
  └──────────────────────────┘                 └────────────────────┘
```

**`src/content.js`** runs inside the listing page. It renders nothing and stores nothing. It waits to
be asked, and when asked it extracts from the page as it is at that instant. It also keeps one timer:
how long after the page was ready did it first become readable.

**`src/extract/*`** are the three tiers, tried in order of robustness:

1. `tier1-structured-data.js` — the schema.org block sites publish for search engines. Robust,
   because they maintain it for their own rankings and the format is fixed by an external standard.
2. `tier2-map-links.js` — coordinates in map links. Has to be right for their own pin to land.
3. `tier3-address-text.js` — the address as printed. Fragile; this is the tier that reads layout.

**`src/popup/*`** is the recorder UI. It asks the content script to read, displays the result, and
takes the operator's verdict.

**`src/lib/`** — `geo.js` (rounding and distance), `storage.js` (records and the declared cohort).

There is **no background service worker**. There was; it is gone. See below.

### Why the popup asks instead of the page telling it

This is worth understanding because it is the single thing most of this codebase's history was about.

The earlier design had the content script measure continuously and publish readings into shared
storage, which the popup later collected. That made it possible for a stored reading to describe a
page you had already left — and Booking and Airbnb are both `pushState` applications, so the URL
changes without a page load and there is no reliable event announcing it. Polling, mutation
observers, DOM fingerprints, document ids, sequence numbers, service-worker navigation epochs: each
one closed a gap and opened another, and the failure was always the same shape — listing A's
coordinates presented as listing B's.

Reading on demand deletes the problem rather than defending against it. The reading is taken
milliseconds before it is displayed, from the page on screen, because someone opened the popup. It
cannot go stale, because it does not exist until it is needed and is not kept afterwards.

That change removed the service worker, all the navigation state, and about 1,000 lines.

### What still tracks navigation, and why it is safe

The content script keeps a small navigation signal — `navigate`, `popstate`, `hashchange`, and a
500ms poll — used **only** to decide whether the readiness timer still applies to the current page.
If it is wrong, a latency is reported as unmeasured. It can no longer cause a coordinate to be
attributed to the wrong page, because nothing is stored between navigation and display.

## How it relates to the consumer platform

**It shares contracts, not code.** Deliberately: code that runs inside third-party pages should not
share a repository, dependencies, or a release pipeline with the application that takes payments, and
store review puts this on someone else's timetable.

What it shares:

- **The proximity endpoint** — one anonymous route, a coordinate in, nearby published gyms out. The
  extension holds no database credentials of any kind.
- **The address and country-code conventions**, settled across the other FTNSS apps. A fourth surface
  reinventing them is how the same bug lands a fourth time.
- **The design tokens** (STARK), for the product panel.
- **The hand-off**: buying a pass links out to ftnss.fit with a `from=ext` marker, so attribution is
  measured server-side, on our own property.

What it does **not** share: any account system, any payment path, any session. v1 is anonymous.

## Cross-platform: where this actually stands

**Today it is Chrome-only.** Being straight about that rather than implying otherwise.

| Browser | Status | What it needs |
|---|---|---|
| **Chrome / Edge** | Works. MV3, this is the target | — |
| **Firefox** | **Not yet.** Not in the original spec | Firefox supports MV3 but uses the `browser.*` namespace and event pages rather than service workers. We call `chrome.*` in ~10 places and have no service worker any more, which helps. Roughly a day: a thin namespace adapter and a separate manifest key |
| **Safari** | **Not yet.** Spec phase 4, gated on Chrome traction | A separate build wrapped in an Xcode project, shipped through the Mac App Store, requiring an Apple Developer account. Closer to shipping a small Mac app than flipping a switch |

Browser APIs currently used: `chrome.runtime` (messaging, `getURL`), `chrome.storage.local` and
`.session`, `chrome.tabs.query` and `.sendMessage`. All have `browser.*` equivalents in Firefox. The
one modern API we rely on — the **Navigation API**, for detecting `pushState` — does not exist in
Firefox or Safari, which is why the polling fallback is there and must stay.

**Making it portable is a decision, not a detail**, and it should be recorded in
[`docs/DECISIONS.md`](docs/DECISIONS.md) before the work rather than discovered during it.

## The rules this code is held to

The privacy claim is the product, so four properties are enforced rather than promised:

1. **Narrow, named host permissions.** Never `<all_urls>`, never a wildcard TLD. A test fails the
   build otherwise.
2. **Nothing identifying the page leaves the browser.** No URL, hostname, title, or content — in any
   request, log, or export. A test fails the build if any source file even contains `fetch(`, and
   another asserts that no exported record carries a site label of any kind, however coarse.
3. **Coordinates are rounded to 500m cells at a single outbound boundary** that no caller can
   bypass, giving a worst-case error of ~320m. The grid is latitude-aware, because a fixed number of
   decimal places is ~1.1km at the equator and ~190m at 80°N.
4. **The source is published**, so all of the above can be checked rather than believed.

Plus one behavioural rule that matters as much: **absence is never rendered as a negative.** If a
read fails, the UI says it could not read the page. An empty panel is indistinguishable from "FTNSS
has no gyms here", which is a false statement about our own supply at the worst possible moment.

Full rules for changes: [`AGENTS.md`](AGENTS.md).

## Testing

```bash
npm test
```

Four layers. The split matters, because every serious bug this repository has shipped was invisible
to the layer above it.

| Layer | File | What it protects |
|---|---|---|
| **Unit** | `tools/extract.test.mjs` | The extractors against hostile input — malformed JSON, prototype pollution, deep nesting, conflicting candidates, polar and antimeridian rounding |
| **Invariant** | `tools/no-network.test.mjs`, `tools/module-graph.test.mjs` | No network call anywhere, no UI injected into the page, permissions that cannot grow, every named import resolving, every used helper actually imported |
| **End-to-end** | `tools/e2e.test.mjs` | A realistic listing page all the way to a report row |
| **Executable** | `tools/popup.test.mjs` | **Runs the popup** — loads it against a mock DOM, renders, clicks Log, asserts a record appears |

The last layer exists because **four wiring bugs shipped from `popup.js`**, and each one looked
exactly like working code: `cohortRecordFor is not defined` on pressing Log, then `MAX_POLLS is not
defined` on every page.

A missing import or an undeclared constant is **not a syntax error**, so `node --check` passes it.
It is **not a resolution error**, so the module-graph test passes it. It is a `ReferenceError` on one
code path at runtime, and the only thing that finds those is running the code.

Its fixture is the page that broke it every time: a Booking.com listing that yields an address, never
a coordinate, and therefore never settles.

What still needs a real browser: the manifest, real message passing, and the DOM of a real site.

## Running it

```bash
npm test
```

To use the harness: `chrome://extensions` → Developer mode → **Load unpacked** → select `src/`. Then
follow [`docs/PHASE-1-MEASUREMENT.md`](docs/PHASE-1-MEASUREMENT.md).
