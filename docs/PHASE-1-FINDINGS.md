# Phase 1 — findings

_Measured 30–31 July 2026. 63 listings logged by hand: 48 Booking.com, 15 Airbnb._

Spec §7 sets the gate: *"Insist on seeing that number before approving phase 2."* This is that number,
and the things measuring it turned up that the spec did not anticipate.

---

## The short version

**Every page we looked at yielded something usable. None yielded nothing.**

But the two sites answer in completely different ways, and the spec had them the wrong way round.

| | Booking.com (n=48) | Airbnb (n=15) |
|---|---|---|
| **Coordinate** | **0%** | **100%** |
| Address only | **100%** | 0% |
| Nothing | 0% | 0% |
| Answered by | tier 3 | tier 1 (89%), tier 2 (11%) |

Spec §3 built its case on structured data being reliable on hotel sites, with Airbnb flagged as the
one that "publishes less than the hotel chains do". **The inverse is true.** Airbnb publishes
coordinates in its JSON-LD on every page measured. Booking.com publishes none, anywhere — not in
JSON-LD, not in map links, not in meta tags, not in data attributes.

---

## Gate 1 — the read rate

### Airbnb: coordinates, and they are accurate

100% of pages produced a coordinate, 89% straight from `ld+json.geo`.

Four were verified against the real location:

```
24m   29m   42m   52m
```

For scale: the transmission grid is 250m and the search radius is 5km, so errors of this size are
**smaller than the grid we round to and twenty times smaller than the distances the panel talks
about**.

Stated carefully, because the obvious phrasing is wrong: an error smaller than the cell is *not*
"erased by rounding". Two points a metre apart either side of a cell boundary round into different
cells and end up 333m apart. Cell size bounds the error rounding **adds**; whether a particular pair
survives it can only be answered by rounding both and comparing. The popup does that now — the first
version of this document said "erased", which was the same mistake the tool was making.

**Caveat that matters:** all four verified listings were **hotels on Airbnb**. Airbnb fuzzes location
for *private homes* — host safety, not an accident — and homes are the majority of its inventory and
the stronger use case per spec §1 (a month in an apartment is the sharpest argument for a day pass).
Whether that 24–52m holds for homes is **unmeasured and not measurable from outside**: confirming a
private home's exact location requires booking it.

The risk is bounded rather than open-ended. We round to 250m and say "about 2km"; a fuzzed point a
few hundred metres out still answers "is there a gym near here". It would take an offset of more than
about a kilometre to actually mislead. This is a thing to watch in production, not a reason to stop.

### Booking.com: no coordinates, ever, but a complete address every time

0 of 48 pages published a coordinate. The reason is identical on all of them:
`lodging type found, no coordinates published` — Booking publishes a `Hotel` block with an address
and no `geo`. Tier 2 found nothing either, across map URLs, `geo.position`, `ICBM`, `og:latitude`,
`place:location:*` and `data-lat`/`data-lng` on map containers.

**This is not our reader being strict.** The extractor distinguishes "no coordinates published" from
"coordinates present but refused", and it reports the former every time.

What Booking *does* publish, on 100% of pages carrying structured data:

| Component | Present |
|---|---|
| Street | 100% |
| Locality | 100% |
| Postcode | 100% |
| Country | 100% |

(The country *code* was recorded only while that question was open. It has been dropped from records
since — the finding is written down, and keeping it would put location onto rows that carry none.)

**So the Booking path is: address → geocoder → coordinate.** That is the tier spec §3 calls "the
least reliable" and puts last, and it is the main path for roughly half the market.

---

## Gate 2 — supply coverage: NOT MEASURED

Of the listings we read correctly, how many have an FTNSS gym near enough to show?

**This has not been measured and could not be.** It needs the proximity endpoint, which does not
exist. The harness records the rounded point the product would send, so coverage can be computed over
this same sample the moment the endpoint is built.

This was always the second half of the gate, and it remains open: a read rate says how often we can
locate a listing, not how often we have anything to show for it. Those are independent numbers and
only one of them is measured here.

---

## Latency

The extraction itself is not the cost:

```
extraction        median 4.8ms      (budget 150ms)
page → readable   median ~1.3s      (Booking), 764ms overall
```

The budget question is almost entirely about **how long the site takes to become readable at all** —
a content script cannot run before `document_idle`, and Booking listings took a median of 1.3 seconds
to get there, with the slowest at 5.8 seconds. No change to our code moves that, and the product's
panel would wait exactly as long.

Worth stating plainly because the first draft of this measurement read as an extraction problem and
was not one.

---

## What geocoding costs, and why it is a privacy decision first

A hotel's street address **is** the listing identity. Sending it anywhere to be geocoded gives away
precisely what §4.2 promises the extension cannot know — and in a public repository, anyone can read
the call.

**Coarse geocoding resolves it**: postcode plus country, never the street, which lands inside the
250m we round to anyway. The measurement says this is possible — both components are present on
every page.

Two caveats, both product decisions rather than engineering ones:

- **Postcode precision is not comparable across markets.** A UK, Dutch or Canadian postcode resolves
  to a building or a handful — *finer than our own rounding*, so geocoding one leaks no less than the
  street would. A US ZIP covers several square kilometres — coarser than the panel's search radius,
  so results get materially worse. Coarse geocoding is a real win in some countries, an empty gesture
  in others, and a quality regression in the US.
- **Self-hosting matters more than the vendor.** Photon was chosen for typo-tolerant autocomplete,
  which is not this job — nothing is typed here. Nominatim or Pelias take structured fields natively
  and can be self-hosted, and self-hosting is what removes a third party from the path entirely.

Full reasoning: [`DECISIONS.md`](DECISIONS.md) §13.

---

## What the measuring taught us about measuring

Worth recording, because it generalises beyond this project.

**Every defect in the instrument flattered the result.** Unrecordable misses, extraction that never
retried, permanently-provisional readings, a hit rate that divided by the verified subsample and
would have read 100% off a single row. Not one erred toward pessimism. An instrument's bugs are not
randomly signed — they tend to favour the answer you were hoping for, and that is worth assuming
rather than discovering.

**A verdict without a measurement in front of it is a guess.** The first verified reading was marked
*wrong*; its measured error was 42 metres. By eye, 42m and 2km are indistinguishable. The popup now
shows the distance as ground truth is typed, and the report flags any "wrong" whose measured error is
inside the grid cell.

**"Absent" and "present but unreadable" are opposite findings.** Booking's country came back null on
24 of 27 pages. That looked like Booking not publishing it. It was our parser accepting only ISO
codes while Booking publishes names. Recording *published* separately from *parsed* is what surfaced
it — the same distinction that separated "no coordinates published" from "coordinates present but
refused", which is the only reason we know the Booking finding is about Booking.

**Twenty-five rounds of adversarial code review found real defects and could not find these.** The
bugs that mattered lived between components, or in statistics, or in the gap between what a number
was called and what it divided by. One evening of a person clicking found more.

---

## Recommendation

**Phase 1's read-rate gate is passed, with the shape of the answer different from the one the spec
expected.** Every page yielded something; the two sites need two different paths.

Before Phase 2 is approved, three things are outstanding:

1. **Build the proximity endpoint** (spec Phase 0). It is owed regardless, it is the only way to
   answer the supply-coverage gate, and it is the shared surface a future MCP server would use.
2. **Measure supply coverage** over this sample, which the endpoint makes computable retroactively
   because every record carries the point the product would have sent.
3. **Decide the geocoding posture** — the two caveats above are Jordan's calls, not engineering ones.

The Airbnb-homes question stays open and is not resolvable before launch. Design for it: the panel
must mark approximate reads as approximate, which the architecture already supports.
