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

## 11. The site a reading came from is recorded

Each record carries which of the listed domains it came from, matched from the extension's own
allowlist rather than read off the page.

This was raised as a privacy concern three times during review and is a deliberate decision, taken by
the founder rather than by an engineer. The per-site comparison **is** the measurement — the two
sites were chosen precisely because they are structurally different, and the country-code-domain
question cannot be answered without knowing which domain a reading came from. Removing the field
would not make the harness more private so much as stop it being an instrument.

What bounds it: the value comes from a fixed allowlist on an extension that only runs on those
domains, so it discloses approximately what installing it already does; and timestamps are date-only,
so there is no time-correlated trail beside it.

---

## Deliberately not in v1

| Deferred | Why |
|---|---|
| Showing the user's own passes | Requires credentialed cross-origin auth — see §1 |
| Classes and events in the panel | Blocked on backend work that is a separate project |
| Safari | A separate build shipped through a different store; gated on Chrome traction |
