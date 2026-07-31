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

## Two numbers, two denominators

The report keeps these apart and states each `n`, because they are measured on different samples and
must never be quoted as one.

**Extraction** — what we could read. Mechanical, recorded on **every** logged page, so the sample is
as large as you care to make it. This is where the tier breakdown and the "why tier N gave up"
section live, and it is the number that says whether the reading approach works at all.

| Outcome | Meaning |
|---|---|
| **coordinate** | A point. The thing the product needs |
| **address only** | Tier 3 found an address but no point. Geocodable — not a hit here, but not a failure either |
| **ambiguous** | The page carried coordinate evidence that disagreed with itself. We refuse rather than pick, because choosing between conflicting evidence is guessing |
| **nothing** | No tier could read it. An honest miss |

**Correctness** — whether a coordinate was the *right place*. Only a person can judge that, so it is
a **subsample**, and the report says how small. A **hit** is a verified-correct coordinate inside the
latency budget: 800ms from page-ready to the reading existing, extraction ≤150ms.

**Log everything; verify some.** Verification is the expensive part, so spend it deliberately —
roughly one in five is plenty. But **not zero**: the wrong-rate is the number that decides this
project, and with nothing verified the report prints `NOT MEASURED` rather than quietly implying it
is fine.

### Why a wrong read is worse than no read

A miss is the panel honestly saying it could not read the page. A **wrong** is a gym shown next to
the wrong hotel — the panel lying with confidence, at the moment someone is deciding where to stay.
A single "accuracy" number hides the distinction, and hiding it is how a project ships on a figure
that looked fine.

## What this harness does NOT measure

Stated here because a limitation nobody wrote down becomes a result somebody quotes.

- **A page that never becomes readable is measured as unreadable, but not immediately.** Extraction
  retries for a few seconds after load if nothing was found, because both measured sites render
  asynchronously and a listing whose data lands just after the page settles is readable, not absent.
  Without that, the error would fall on slower pages and slower connections — biasing the hit rate
  upward by exactly the cases the product will find hardest.

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

Load `src/` as an unpacked extension. No build step and no dependencies — it runs exactly as
written, which is also the easiest thing to audit.

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `src/`.
2. Browse listings. **Open the toolbar popup on each one.** Opening it reads the page as it is at
   that moment, so what you see always describes the page in front of you. The site is detected
   automatically — there is nothing to select and nothing to switch between.
3. Press **Log**. That is the whole interaction. It records what the extractor found; the extension
   already knows which, so it does not ask you to restate it.

   Optional, when a coordinate was found and only when you feel like it: whether the point is the
   **building** or an **area**, whether it is **correct** or **wrong**, and the hotel's real
   `lat, lon` for the positional-error figure.

   **Not a listing** on a search or help page records nothing — a non-listing must not enter the
   denominator, and the extractor genuinely cannot tell.
4. Toolbar icon → **Export JSON**. One file for the whole session, across both sites.
5. `npm run report measurements/<file>.json` — once, for the whole session. It splits by site and by
   primary-vs-country-code domain itself.

**Read the "why tier N gave up" section first.** It is the most useful output of this phase.
`no coordinates published` and `coordinates present but refused` are opposite findings: the first is
a fact about the site, possibly a market we cannot serve; the second is a fact about **us**, and a
bug in what we accept.

Tests: `npm test`. They cover the extractors against hostile input, the full pipeline end to end, and
assert mechanically that **no source file makes a network request** and that the manifest never asks
for `<all_urls>`.

## What is recorded

Deliberately, **no page identifier**: not the URL, not the hostname, not the address text.

- **Nothing derived from the URL is kept**, not even a hash. A 32-bit hash of a URL from a known
  short list of sites is walkable, so cross-session dedup was dropped rather than kept as a token
  gesture.
- **The site each record came from IS recorded** — as a family and a variant (`booking`, `primary`),
  detected from the page, never a hostname. This reverses an earlier decision; see
  [`DECISIONS.md`](DECISIONS.md) §11 for why the harness may do this and the shipped product may not.
- **The projection is applied when a record is written**, not when it is exported, so the trail never
  exists on disk. It is a strict **allowlist** — a field added later is withheld until someone
  decides it belongs, where a denylist protects only the fields somebody remembered.
- Coordinates are stored only as the ~1.1km point the product would itself transmit, and that
  rounding is **re-applied at the storage boundary** so it does not depend on the caller remembering.
- Timestamps are **date-only**. A precise time beside a site label is the makings of a browsing log,
  and nothing in the report groups more finely than a day.

**What this costs:** a reading cannot be re-audited afterwards. Verification happens at the moment of
logging, by the person looking at the page — which is when the evidence is best — but a disputed
number cannot be re-litigated from the export.
