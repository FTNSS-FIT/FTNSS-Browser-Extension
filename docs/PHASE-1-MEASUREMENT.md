# Phase 1 — the measurement protocol

Phase 1 is not a product increment. It is an instrument, built to answer one question before anyone
commits to building the thing: **how often can a listing page's location actually be read, correctly
and fast enough to matter?**

Everything here is internal and unpublished. The harness is never submitted to a store.

## How the sample is gathered

**A person browses real listings normally, in their own browser.** The harness runs on the page they
are already looking at, shows what it managed to extract, and asks them to say whether it is right.

This is deliberately slower than scripting it. An automated fetcher visiting listing pages and
storing the results is, by any reasonable definition, the scraping this project says it does not do —
and a principle that applies only to the shipped build is not a principle. Doing it by hand keeps
"we have never crawled these sites" true of **everything we have ever run**.

Two sites: **Booking.com** and **Airbnb**. They are the two structurally most different cases — a
pure OTA with search-critical structured data, versus a marketplace that withholds exact addresses by
design. Measuring the two *easiest* sites is how a 90% proof-of-concept becomes a 60% product.

**ccTLD coverage is enumerated, not guessed.** Both sites operate country-code domains, so a match
list covering only `.com` would silently give nothing to exactly the users a 57-locale product
exists to serve. The domains in the manifest were checked by DNS resolution on 2026-07-30 rather
than recalled — 24 Airbnb ccTLDs and several Booking ones resolve, and all are listed explicitly.
No wildcard TLD is used.

What DNS establishes is that the domains *exist*, not that they serve listing pages or serve the
same markup. That is one of the things this phase measures.

## What counts as a hit

A **hit** requires all three:

1. A coordinate was extracted.
2. It is **correct** — checked by the person against the address on the page. Within ~1km counts,
   because ~1km is the precision the product deliberately rounds to anyway.
3. It arrived inside the budget: **800ms** from page-ready to the reading being available,
   extraction **≤150ms**. A correct read that arrives after the user has moved on is worth nothing.

   **What that clock does and does not include.** It measures the pipeline — page ready until a
   reading exists — which is the latency the product's own panel would inherit. It does *not* include
   how long the popup took to open, because the popup opens when the operator clicks it, and folding
   that in would measure the person rather than the page. On a soft navigation the measurement can
   also be up to one poll interval late, so the error bar is recorded per row and added before the
   budget comparison.

## Why misses and wrongs are counted separately

They are different failures and they need different budgets.

| Outcome | What it means |
|---|---|
| **Miss** | We could not read the page, and the panel says so. Acceptable behaviour |
| **Wrong** | We read the page and got the wrong place — a gym shown next to the wrong hotel. The panel is confidently lying, which is worse than admitting failure. **This must be near zero** |

A single "accuracy" number hides the distinction, and hiding it is how a project ships on a figure
that looked fine.

## What this harness does NOT measure

Stated here because a limitation nobody wrote down becomes a result somebody quotes.

- **Tier 3 is an upper bound.** It reports only whether an address *string* was present. Turning one
  into a coordinate needs a geocoder, which is a network call this harness does not make. The real
  tier 3 rate is lower by the geocoder's own error rate on these inputs.
- **Supply coverage is not in this report.** The second question — of the listings we read correctly,
  how many have a gym near enough to show? — needs the proximity endpoint, which does not exist yet.
  The harness records the rounded point that *would* have been sent, so coverage can be computed over
  the same sample once it does.
- **Precision is observed, not inferred.** Whether a site publishes a building or a deliberately
  fuzzed area is a per-site fact to be measured, so the extractor reports `unknown` and the person
  recording says which it was. An earlier version labelled every structured-data read `exact`, which
  on a site that fuzzes location would have recorded every listing as building-accurate — the
  repository's own "never render precision we do not have" rule, broken in the place it mattered
  most.

- **A `correct` verdict requires an extracted coordinate.** Tier 3 produces a string, not a
  location, so the recorder does not offer "correct" when there is no point to judge, and the report
  refuses to count one if an older export contains it.

## Running it

Load `src/` as an unpacked extension. There is no build step and no dependencies — it runs exactly as
written, which is also the easiest thing to audit.

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `src/`.
2. In the popup, **choose the site you are measuring**. That declaration is what gets recorded; the
   site is never read off the page. If the page you are on disagrees with it, the popup says so and
   refuses to record until you fix it.
3. Browse listings. **Open the toolbar popup on each one** — that is the recorder. It shows what was
   read and takes your verdict.

   The popup, not an in-page panel: the page cannot hide it, click-jack it, or watch what you type
   into it, which matters because it displays the "could not read this page" state and captures the
   ground truth the whole measurement rests on. Press **Not a listing** on search and help pages; it
   records nothing and enters no denominator.
4. Toolbar icon → **Export JSON**. Save into `measurements/` (gitignored).
5. `npm run report measurements/<file>.json`

The recorder re-reads the page when you navigate between listings without a reload, and each reading
is bound to the URL it was taken on — so a verdict can never be attributed to a listing you have
already left.

Optionally paste a known-good `lat, lon` into the recorder before saving; the report then includes the
positional error distribution.

Tests: `npm test`. They cover the extractors against hostile input, and they assert mechanically that
**no source file makes a network request** and that the manifest never asks for `<all_urls>`.

## What is recorded

Deliberately, **no page identifier**: not the URL, not the hostname, not the address text.

- **Nothing derived from the URL is kept, not even a hash.** A 32-bit hash of a URL from a known
  short list of sites is walkable, so cross-session dedup was dropped rather than kept as a token
  gesture. Recording the same listing in two sessions counts it twice; the panel guards the
  realistic mistake, which is a double click on one page view.
- The site is **declared by the operator**, and what gets recorded is the family and whether it was a
  country-code variant — `{family: 'airbnb', variant: 'cctld'}`, never `airbnb.jp`. That answers the
  ccTLD question without recording which country. Nothing hostname-shaped is persisted or exported.
- **The projection is applied when a record is written**, not when it is exported, so the trail never
  exists on disk. It is a strict **allowlist** — a field added later is withheld until someone
  decides it belongs, where a denylist protects only the fields somebody remembered.
- Coordinates are stored only as the ~1km point the product would itself transmit, which is inside
  the privacy envelope the product already operates in — and that rounding is **re-applied at the
  storage boundary**, so it does not depend on the caller having remembered.
- Timestamps are **date-only**. A precise time beside a site label is the makings of a browsing log,
  and nothing in the report groups more finely than a day.

An earlier version stored the URL so a disputed reading could be re-checked, and argued it as a
bounded exception written into `AGENTS.md`. That was wrong in two ways: it put a browsing trail on
disk, and changing the rules to permit it would have disarmed the reviewer for every later change.
The rule is absolute; the instrument changed instead.

**What this costs:** a reading cannot be re-audited afterwards at all. Verification happens at the
moment of recording, by the person looking at the page — which is when the evidence is best — but a
disputed number cannot be re-litigated from the export.

**On the ~1km rounding:** the grid is latitude-aware. A fixed number of decimal places is only ~1km
of longitude near the equator — it is about 380m at 70° and 190m at 80°, so a uniform-sounding
guarantee was quietly weakest in the Nordic markets this extension already lists. The longitude step
is now derived from the rounded latitude, giving cells about 1.1km across in both directions
everywhere, and the grid is recomputable from the published coordinate alone.
