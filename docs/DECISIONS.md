# Architecture decisions

Decided 2026-07-30, against spec v0.2. Each entry records **what was decided and why**, so that a
later change is a deliberate reversal rather than an accident.

This file is written to be read by outsiders. It records engineering decisions only.

---

## 1. v1 is anonymous. No sign-in, no session, no credentials

**Decided:** the v1 panel shows nearby gyms to everyone and requires no account. Signing in is a link
to the website, not a state the extension manages.

**Why.** The spec assumed the extension could call our API and have the website's existing session
"come along automatically". It cannot: a call from an extension to our API is **cross-origin**, and
the browser will not attach a session cookie unless the request is credentialed, the server returns a
matching origin with `Access-Control-Allow-Credentials`, *and* the cookie itself is `SameSite=None`.

The last of those is the problem. It would mean loosening the cookie policy on the application that
takes payments, in order to serve a discovery panel. That is a bad trade at any stage and a
particularly bad one before the product has proven it works.

Going anonymous removes the whole class: no credentialed CORS, no cookie change, no CSRF surface, and
no token for the extension to hold or leak. It also means a hostile fork of this code gains nothing —
it can only reach data that is already publicly readable.

**What it costs.** The panel cannot show "you already have a pass valid at this gym", which is the
strongest moment the product has. That is deferred, knowingly, not forgotten.

## 2. One anonymous endpoint. No backend credentials ship

**Decided:** the panel calls a single narrow endpoint — a coordinate in, nearby published gyms out.
The extension holds no database credentials of any kind.

**Why.** The alternative was talking to our database directly from the extension, which would mean
publishing a project identifier and key inside every installed copy, and making row-level rules the
only thing between a hostile fork and our data. A single endpoint we control also means rate limiting,
caching and response shape are ours to change **without a store round-trip** — which matters more here
than in a web app, because a shipped extension cannot be hot-fixed.

A consequence worth stating plainly: because nothing credential-shaped ships, the common
open-source question of "is it safe to publish this key?" does not arise. There is no key.

## 3. Coordinates are rounded at the outbound boundary

**Decided:** rounding to 250m cells happens in one place, at the point of transmission, and no caller can
bypass it.

**Why.** Rounding performed by each caller is correct only for as long as every caller remembers. The
boundary is the only place where the guarantee holds structurally rather than by convention, and a
structural guarantee is the one an outsider can verify by reading a single function.

## 4. Narrow, named host permissions — never `<all_urls>`

**Decided:** the manifest names a short list of sites. Adding one is a deliberate decision with a
record, because widening permissions forces every existing user to re-accept.

Match patterns must cover a listed site's **country-code domain variants**. A list covering only `.com`
silently fails for users outside the English-speaking market, which is a bug, not a gap in coverage.

The permission list is `storage`, and nothing else. `activeTab` was added at one point so the popup
could ask the content script a question, and removed again once it was clear that messaging a content
script the manifest already injects needs no permission at all — it bought nothing and widened the
boundary to every tab the toolbar is clicked on. A test pins the full list, so growth is a decision
rather than a detail.

## 5. Reading a page is tiered, and failure is always visible

The extension tries, in order: published structured data (the machine-readable block sites maintain
for search engines); coordinates embedded in map links; and only as a last resort, visible address
text.

**When all three fail, the panel says it could not read the page.** It never shows an empty result.
An empty panel is indistinguishable from "there are no gyms here", which is a false statement made at
the worst possible moment. This is the most important behavioural rule in the project.

The same principle governs precision: some sites publish only an approximate area by design. That is
sufficient for "is there a gym near here" — it is the same order of precision we deliberately round
to anyway — but an approximate read is **shown as approximate**. A precise distance derived from an
imprecise source is a confidently wrong answer, which is worse than a visible failure.

## 6. We do not crawl, and the measurement work does not either

The extension reads what is already rendered on the user's own screen, on their behalf, and the
reading does not leave their machine. No server of ours visits these sites.

That constraint applies to our **development process too**, not just the shipped build: the work
measuring how well page-reading performs is done by a person browsing normally, never by an automated
fetcher. It costs more time and it means the claim above is true of everything we have ever run,
rather than only of the released artifact.

## 7. MIT licence

Permissive, short, and readable in full in less time than it takes to become suspicious of it. The
patent grant in Apache-2.0 is real value when code embodies a patentable invention or many companies
contribute; neither applies to a panel that reads an address and calls an endpoint. Something more
infrastructural would be a separate decision.

## 8. Reproducible builds from the first published version

Every published version is tagged at the exact commit it was built from, and the build is a single
documented command.

**Why this is load-bearing.** Publishing source proves nothing on its own — the obvious question is
"how do I know the extension in the store came from this code?" Without an answer, the repository is
decoration and the privacy claim is still just a claim. This is much cheaper to set up at the start
than to retrofit.

## 9. This repository is separate from the website

Different threat model (code that runs inside third-party pages should not share a repository,
dependencies or a release pipeline with the application that takes payments), different release
cadence (store review runs on someone else's timetable), and a different runtime.

It shares **contracts, not code**: the design tokens, the address and country-code conventions, and
the endpoint. Those were settled across several applications, and a new surface reinventing them is
how the same bug lands a fourth time.

## 10. The UI lives in the extension, and the page is read ON DEMAND

The harness renders nothing into the listing page, and it stores no reading between navigations. The
popup asks the content script to read the page at the moment it opens.

**Why the UI is not in the page.** A panel mounted in the page sits in a document the page controls,
so the page can hide it, move it, swallow its clicks, or observe what is typed into it. The two
things that UI exists for are displaying "we could not read this page" — whose entire value is that
its absence cannot be arranged by the page — and capturing the person's verdict, which is the ground
truth the whole measurement rests on. Neither can live where the subject of the measurement can
interfere.

**Why the reading is taken on demand.** The earlier design published readings into shared storage for
the popup to collect later, which made it possible for a stored reading to describe a page the person
had already left. Booking and Airbnb are both `pushState` applications: the URL changes with no page
load and no reliable event. Polling, mutation observers, DOM fingerprints, document ids, sequence
numbers and service-worker navigation epochs were each tried; each closed one gap and opened another,
and the failure was always the same — listing A's coordinates presented as listing B's.

Reading on demand removes the question rather than answering it. The reading is taken milliseconds
before it is shown, from the page on screen. It cannot go stale because it does not exist until it is
needed. This deleted the service worker, all the navigation state, and roughly 1,000 lines.

**What remains** is a small navigation signal governing one timer — how long until the page became
readable. If it is wrong, a latency is reported as unmeasured. It can no longer misattribute a
coordinate, which is the property that matters.

## 11. The harness records which site each reading came from. The PRODUCT never will.

Each record carries `{family, variant}` — `airbnb`/`booking`, and primary domain or country-code
variant — detected automatically from the page.

**This reverses an earlier decision, and the reversal is the point.** Across three review rounds the
site label was moved out of the row, then coarsened, then moved out of the filename, on the argument
that a label plus a date proves which domain was visited. That argument is sound **for the shipped
product** and was wrongly applied to the instrument.

The harness has no users. It has an operator, who is deliberately recording their own browsing, on
their own machine, into a file that is our internal measurement data. There is no third party whose
privacy the label protects. What the rule actually protects is *a stranger who installed our
extension*, and the shipped product will carry nothing of the sort — enforced by a test, not by
convention.

**What the earlier design cost, which is why this matters:** the operator had to declare a cohort,
export, clear, switch, and re-declare between sites. Every one of those steps is a chance to
mislabel a batch or lose one, and a measurement instrument whose workflow is annoying produces
worse data than one whose workflow is boring. We traded real measurement accuracy for a privacy
property that protected nobody.

**The boundary, stated so it survives:** automatic site detection and per-record labelling exist in
the harness only. Neither may appear in a shipped build. The distinction is not "internal code is
exempt from the rules" — it is that this rule is about *users*, and the harness has none.

## 12. What the panel shows: the six nearest gyms, within a maximum radius

**Decided (Jordan, 2026-07-30):** the panel shows the **six nearest** published gyms to the queried
point, and nothing beyond a maximum radius. Ranking is by distance.

**Why a cap on both.** Six is about what a small panel can show without becoming a directory, and a
traveller deciding "can I train here?" needs the nearest few rather than all of them. The radius
matters more: without one, the sixth result in a thin market could be in another city, and a gym
nobody could realistically reach is worse than an honest "nothing near here" — it makes the panel
look like it is padding.

**Proposed radius: 5km**, pending confirmation. The reasoning: under about 2km the result set would
be mostly empty at current supply, and beyond about 5km a gym stops being somewhere you would go from
a hotel. 5km is a short taxi or metro ride in a city, which is still a usable answer.

**How this interacts with the rounding — they are different things.** The rounding is about
*precision of the query point*: we are told roughly where, to within about 160m. The radius is about *how
far we then look*. They are unrelated numbers, but the first constrains what the second can claim:
because the query point carries about 160m of uncertainty, **a displayed distance cannot be more
precise than that**. The panel says "about 2km" or "a short walk", never "400m from this hotel",
which the spec's own mock-up shows and which is not a claim the architecture can support.

**The empty case is a result, not a failure**, and must read that way: "no FTNSS gyms within 5km"
is true, useful, and — per §1 of the spec — the market-expansion signal worth collecting. It must
never be confused with "we could not read this page", which is the different failure the panel also
has to be able to state.

## 13. Geocoding is a privacy decision before it is a vendor decision

**Open — not decided.** Recorded now because the first measured session forced the question.

Booking.com published no coordinates on 8 of 8 pages: a `Hotel` block with an address, no usable map
URL. If that holds, the Booking path needs a geocoder, and that collides with the architecture.

**A hotel's street address is the listing identity.** "12 Example Street, Exampleton" identifies
which property someone is looking at as precisely as the URL does. So sending it anywhere to be
geocoded gives away the thing §4.2 of the spec promises we cannot know:

| Where it runs | What it costs |
|---|---|
| Extension → third-party geocoder | The address leaves the browser to a **third party**, in a public repo, where anyone can read the call |
| Extension → our own server | **We** learn which property is being viewed. "We don't log it" is a policy promise, and this project's argument is that its guarantees are architectural |
| Client-side, offline | Not viable — street-level data for one country is far too large to ship in an extension |

**The likely resolution: geocode coarsely.** We round to 250m cells anyway, so we do not need street
precision. Geocoding **postcode plus locality** lands inside our own rounding error and does not
transmit the listing identity. A coarser query is a better answer than a broken promise.

**On the vendor**, once the above is settled: Photon was chosen for a different job — typo-tolerant
autocomplete for humans typing into a box. Nothing here is typed; the input is a clean structured
address. For structured forward geocoding the realistic options are Nominatim or Pelias, both of
which can be **self-hosted** — which matters more than their accuracy difference, because a
self-hosted geocoder means no third party is in the path at all.

**Measuring it before building it.** The harness now reads the structured `PostalAddress` from the
same lodging node tier 1 already finds, and records **which components exist** — never their values.
That answers the question the decision turns on without transmitting anything:

- Does the page publish components *separately*? A scraped address string cannot be split, so coarse
  geocoding is impossible on a page that only renders one.
- Is there a postcode **and** a country? That is the minimum that resolves anywhere.
- Which country? This is the part most likely to be underestimated: **postcode precision is not
  comparable across countries.** A UK or Dutch postcode identifies a building — finer than the 250m
  we round to, so geocoding one would be no coarser than sending the street. A US ZIP covers several
  square kilometres, which is coarser than our search radius is tight. "Coarse-geocodable" means
  something different in each market, and a single global answer would be wrong in both directions.

The report prints all three. If the answer is that most pages carry a postcode and a country, coarse
geocoding is viable and the street never has to leave the browser. If most carry only a street, the
decision is harder and belongs back with Jordan.

### Measured, 2026-07-31 — 34 Booking pages

| | |
|---|---|
| Structured `PostalAddress` published | **100%** |
| Street, locality, postcode | **100%** |
| Country published | **100%** |

**Coarse geocoding is viable.** Postcode and country are present on every page measured, so the
street never has to leave the browser. That resolves the tension above in the good direction.

Two caveats that survive the measurement:

**Postcode precision is not comparable across markets, and this is the part that decides how much
the privacy win is worth.** A UK, Dutch or Canadian postcode resolves to a building or a handful of
them — *finer than the 250m we round to*, so geocoding one leaks no less than the street would. A US
ZIP covers several square kilometres — coarser than the panel's own search radius, so results would
be materially worse. The honest position is that coarse geocoding is a genuine privacy improvement
in some countries, an empty gesture in others, and a quality regression in the US. Whether to vary
behaviour by country is an open product question, not an engineering one.

**Our reader was the bottleneck, not the sites.** The first measurement reported a country on 11% of
pages; the truth was 100%. Booking publishes names (`"Canada"`), not codes, and the parser accepted
only codes — so a component that was there all along was reported absent. Recording *published* and
*parsed* separately is what surfaced it, and it is the same distinction that separated
"no coordinates published" from "coordinates present but refused".

**Before any of this, confirm the premise.** Coordinate probing was extended to meta tags
(`geo.position`, `ICBM`, `og:latitude`, `place:location:*`) and `data-lat`/`data-lng` attributes,
because a site that renders its map client-side must have the point in the document somewhere. If
Booking's coordinates turn out to be there, this entire decision is moot and nothing needs geocoding.

Deliberately excluded from that probing: regex-scanning inline scripts for number pairs. That is
where a confidently-wrong coordinate would come from, and on a site where no other tier produces one
there would be nothing to cross-check it against.

## 14. Expedia Group added to the harness — 61 hosts, and why that is not the product's list

**Decided 2026-07-31.** The harness matches 61 hosts: Booking (4), Airbnb (24), and Expedia Group
(33 — 31 Expedia country domains plus `hotels.com` and `vrbo.com`).

§4 requires a decision record for any growth in the host list. This is it.

**Why.** Booking publishes no coordinates on 48 of 48 pages; Airbnb publishes them on 15 of 15. We
know two shapes of answer and nothing about which is typical, and that difference is a materially
different Phase 2: geocoding as a minority path, or as the main path for two-thirds of the market
with the postcode-precision-by-market caveat attached to most of it. A third family settles it.

**Why every country domain rather than a sample.** A partial list is the exact bug §4's ccTLD rule
exists to prevent: the content script silently never runs on an omitted domain, and its absence reads
as *a market with no listings* rather than *a gap in our manifest*. That is a measurement error
disguised as a finding, and it would be invisible. Every domain listed was confirmed to resolve by
DNS on 2026-07-31.

**Why this does not set the product's list.** The harness is internal, unpublished, and installed by
one person who wants it. The shipped extension's site list is a **separate decision with a real
cost**: every named domain is a permission prompt, growth forces existing users to re-accept, and a
manifest listing sixty domains reads to a store reviewer as `<all_urls>` written out longhand — which
is the concern raised when the v1 list was first scoped and remains unresolved.

**Nothing else grew.** Permissions are still `storage` alone, asserted by test. What widened is the
set of pages a content script may read, on an unpublished internal build.

---

## Deliberately not in v1

| Deferred | Why |
|---|---|
| Showing the user's own passes | Requires credentialed cross-origin auth — see §1 |
| Classes and events in the panel | Blocked on backend work that is a separate project |
| Safari | A separate build shipped through a different store; gated on Chrome traction |
