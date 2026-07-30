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

**Decided:** rounding to ~1km happens in one place, at the point of transmission, and no caller can
bypass it.

**Why.** Rounding performed by each caller is correct only for as long as every caller remembers. The
boundary is the only place where the guarantee holds structurally rather than by convention, and a
structural guarantee is the one an outsider can verify by reading a single function.

## 4. Narrow, named host permissions — never `<all_urls>`

**Decided:** the manifest names a short list of sites. Adding one is a deliberate decision with a
record, because widening permissions forces every existing user to re-accept.

Match patterns must cover a listed site's **country-code domain variants**. A list covering only `.com`
silently fails for users outside the English-speaking market, which is a bug, not a gap in coverage.

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

## 10. The measurement UI lives in the extension, not in the page

The phase 1 harness renders nothing into the listing page. The content script reads the page and
publishes what it read; the recorder is the extension popup.

**Why.** A panel mounted in the page sits in a document the page controls, so the page can hide it,
move it, swallow its clicks, or observe what is typed into it. The two things that UI exists for are
displaying "we could not read this page" — whose entire value is that its absence cannot be
arranged by the page — and capturing the person's verdict, which is the ground truth the whole
measurement rests on. Neither can live somewhere the subject of the measurement can interfere with.

Three separate review rounds each found a different way to subvert an in-page panel: remove the host
element, plant a decoy carrying its id, hide it with CSS. Each fix was sound and each was answered by
a new variant, because the problem was structural rather than a series of oversights. Browser-owned
UI is not a hardening of that design; it is the design that does not have the problem.

## 11. The site is DECLARED by the operator, not derived from the page

Each record carries which site was being measured. That value is chosen by the person doing the
measuring, before they start — it is never read from the page.

**Why it exists at all.** The per-site comparison *is* the measurement. The two sites were chosen
precisely because they are structurally different, and the country-code-domain question cannot be
answered without knowing which domain a reading came from. Dropping the field would not make the
harness more private so much as stop it being an instrument.

**Why it is declared rather than detected.** Deriving it from the page's hostname and writing it into
an exported file makes that file a record of which domains were visited — the thing this project's
rules say never leaves the browser. Both were true at once: the analysis was necessary and the
provenance was wrong. Declaring it keeps the entire analysis with nothing page-derived persisted.

**And what is recorded is the family, not the hostname.** Fixing the provenance was not enough on its
own: `airbnb.jp` is still a hostname, and because recording is refused unless the declaration matches
the page, an export carrying it would still have proved which domain was visited. Records carry
`{family: 'airbnb', variant: 'cctld'}` — which answers the question the phase actually asks, *do
country-code domains behave differently from the primary one?*, without recording which country.

**Accuracy is not traded away for it.** The content script still reports what it detected, and the
popup refuses to record while the declared cohort disagrees with the detected page. That check runs
in the browser and the detected value is never written to a record — so a mislabelled cohort is
caught without the label ever being page-derived.

## 12. `activeTab` — the one permission beyond storage

The phase 1 harness requests `activeTab` in addition to `storage`.

**Why.** Before a verdict is recorded, the popup asks the content script whether its reading still
describes the page on screen. Nothing else can answer that: re-reading stored state cannot detect a
navigation the content script has not noticed yet, because the stale reading is exactly what gets
re-read. Only the script running in the page can compare against the live URL.

**Why it is the right permission.** `activeTab` is granted per-invocation, when the person clicks the
toolbar icon, and only for the tab they clicked on. It cannot be used in the background, on other
tabs, or without a deliberate action. It shows no additional warning at install.

**What the answer contains.** A boolean and a sequence number. Never the URL — establishing that two
things are the same does not require transmitting the thing being compared.

This is a harness permission. Whether the product needs it is a separate decision, to be taken on its
own terms rather than inherited.

---

## Deliberately not in v1

| Deferred | Why |
|---|---|
| Showing the user's own passes | Requires credentialed cross-origin auth — see §1 |
| Classes and events in the panel | Blocked on backend work that is a separate project |
| Safari | A separate build shipped through a different store; gated on Chrome traction |
