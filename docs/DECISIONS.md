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
matters more: without one, the sixth result could be in another city, and a gym nobody could
realistically reach is worse than an honest "nothing near here" — it makes the panel look like it is
padding.

**Proposed radius: 5km**, pending confirmation. The reasoning: much under 2km and the radius starts
excluding gyms a traveller would happily walk to, while beyond about 5km a gym stops being somewhere
you would go from a hotel at all. 5km is a short taxi or metro ride in a city, which is still a
usable answer.

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
(53 — 31 Expedia country domains, 6 Hotels.com, 16 Vrbo). 81 hosts in total.

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

## 15. The panel lives in the popup, and the endpoint's origin is granted at runtime

**Decided 2026-07-31.**

**The panel is not injected into the page.** The content script's invariant is that it renders
nothing and publishes nothing — it reads the DOM when asked and answers. Injecting a panel ends
that: our markup would live inside a document we treat as adversarial, inheriting its CSS, visible
to its scripts, and mutating a page nobody asked us to change.

The cost is real — a click away instead of in front of them — and it is a product question for a
later phase. It is also reversible, which the invariant is not. Giving up "we never touch the page"
is a one-way door, and it should be walked through on purpose rather than because a panel needed
somewhere to live.

**The endpoint URL is stored, not compiled in**, and its origin is requested at runtime through
`optional_host_permissions`. Two reasons:

- **Which environment we can call is unresolved.** Consumer Web's dev origin is Vercel-auth-gated
  and an extension cannot pass that gate. A compiled-in default would settle that question by
  omission, and the environment nobody chose would be the one that gets called.
- **A compiled-in host permission appears in the install prompt** before anyone has decided what it
  should be, so it would have to be broad enough to cover the undecided answer. Asking for the one
  origin a person just typed is both narrower and more truthful.

`host_permissions` stays absent and the `permissions` array stays `["storage"]`. Both are asserted.

## 16. Exactly one file may reach the network, and it is named in a test

**Decided 2026-07-31.**

Phase 1 forbade network access absolutely, enforced by a source scan. The proximity panel ends that,
because asking what is near a point requires asking someone. The rule changes shape rather than
relaxing: `src/lib/proximity.js` is allowlisted by name, and every other file in `src/` is held to
the original absolute rule.

**Worth recording that the old guard failed to fire.** `gymsNear` takes `fetchImpl = fetch` and
calls `fetchImpl(...)`, and the pattern `\bfetch\s*\(` matches neither — the default has no
parenthesis after it, and the call site is a different identifier. The first network request in the
project's history landed without tripping the test written to force a conversation about exactly
that, and nobody noticed because nothing prompted them to.

A guard that can be walked past by renaming a variable is not a guard, and an accidental walk-past
is worse than a deliberate one. The patterns now match bare references, the allowlist is asserted to
name a file that exists, and a structural test checks the request body is one literal built from one
rounded point with no spread — so the privacy claim is auditable by reading, not only by testing
behaviour.

## 17. Distances are shown, as marked estimates rather than claims

**Decided 2026-08-01, reversing a removal made the same week.**

Distances were deleted from the panel entirely. The reasoning was sound and is worth keeping: the
transmitted point is a 250m grid cell, so a reported 499m can be ~674m from the listing, and
**"under 500 m" is then simply false**. Four attempts at wording — `390 m`, `about 400 m`,
`under 500 m`, then nothing — each less wrong than the last while the underlying problem stayed
exactly where it was.

They are back because **a list of gyms with no distances is a worse product**, and a traveller
deciding whether to walk needs some sense of how far. That is a real cost, and deleting the feature
paid it in full to avoid an error at a boundary.

**What changed is the kind of statement being made.** `~1.1 km` asserts an approximation.
`under 500 m` asserted a bound — and a bound is precisely what a 250m grid can falsify. The tilde is
load-bearing, the panel repeats the caveat in words beneath the list, and a reading the extractor
itself marked `approximate` says so more strongly.

Rounded to 100m below a kilometre and 0.1km above. That is finer than the grid strictly justifies,
and it is defensible **only** because nothing is presented as exact. If anything downstream ever
starts treating these as measurements — sorting by them across sources, comparing them between
gyms, showing them next to a walking time — this decision needs revisiting, because at that point
they stop being a marked estimate and become a number people act on.

## 18. Pass filters are keyed on KIND, and include kinds with no local inventory

**Decided 2026-08-01.**

The filter offers the six canonical `pass_kind` values: `day`, `weekend` (3-day), `week`, `month`,
`quarter` (90-day) and `year`.

**Keyed on `kind`, not on a day count**, and that correction matters more than it looks. `days` is
not a field the consumer path reads at all — the site, mobile and partner all filter on `kind`. This
extension originally keyed on `days`, which meant it filtered by a column the rest of the platform
ignores, and a measurement of "which durations exist" answered a question about the wrong column.

**`quarter` exists for a legal reason, not a product one.** Pennsylvania caps prepaid membership
contracts at three months, so a 90-day pass is how a PA gym sells anything longer than a month — and
there is a live PA gym. A query returning no rows was very nearly grounds for deleting that filter,
which would have removed the mechanism keeping a whole US state sellable.

There is also a legacy `90day` label in the DB enum with no rows. It is **refused**: `quarter` is
canonical everywhere, and accepting both would let a stale producer populate a duration the rest of
the platform cannot see.

A kind with nothing behind it near a given search is shown **disabled** rather than hidden. Hiding them would make
the set of durations change from one search to the next, which reads as an interface glitch; a
greyed chip saying "no gym near here sells this pass" is a true statement about coverage.

Availability is derived from **the response**, never from this list, so a kind that gains inventory
lights up without a code change and one that loses it greys out the same way.

That derivation is also what absorbed a wrong answer. A measurement of mine suggested two durations
had no inventory anywhere; it had queried the wrong column, and one of them was legally load-bearing.
Because the panel reads availability from the response rather than a hardcoded list, the wrong
reading never reached a user and needed no correction in code. **A design that fails safe against
its author's own bad data is worth more than one that is merely correct today.**
