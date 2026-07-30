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

The manifest also includes `airbnb.co.uk` and `airbnb.es`. Those are there to test a specific worry:
that a site's country-code domains serve different markup from the `.com`. If they do, a match list
covering only `.com` would silently fail for exactly the users a 57-locale product exists to serve.

## What counts as a hit

A **hit** requires all three:

1. A coordinate was extracted.
2. It is **correct** — checked by the person against the address on the page. Within ~1km counts,
   because ~1km is the precision the product deliberately rounds to anyway.
3. It arrived inside the budget: **800ms** from page-ready to panel-rendered, extraction **≤150ms**.
   A correct read that arrives after the user has moved on is worth nothing.

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
- **Precision is recorded, not judged.** Whether a site publishes a building or a fuzzed area is a
  per-site fact to be measured. Marking a read approximate on a hunch would bias the result, so the
  human verification step is what establishes it.

## Running it

Load `src/` as an unpacked extension. There is no build step and no dependencies — it runs exactly as
written, which is also the easiest thing to audit.

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `src/`.
2. Browse listings. The recorder appears on listing pages; record a verdict on each.
3. Toolbar icon → **Export JSON**. Save into `measurements/` (gitignored).
4. `npm run report measurements/<file>.json`

Optionally paste a known-good `lat, lon` into the recorder before saving; the report then includes the
positional error distribution.

Tests: `npm test`. They cover the extractors against hostile input, and they assert mechanically that
**no source file makes a network request** and that the manifest never asks for `<all_urls>`.

## A note on the URL

The harness stores each listing's URL in local browser storage. The shipped product never will.

The reason is that a measurement without ground truth is worthless, and checking a read means being
able to return to the listing. It stays on the machine that did the browsing, is never transmitted,
and is exported only by an explicit click into a gitignored directory. It is a bounded exception for
a development tool, and it goes away when the harness does.
