# AGENTS.md — FTNSS Browser Extension

Guidance for any automated agent working in this repository.

## What this repository is

A browser extension that reads the address of a hotel or rental listing **from the page the user is
already looking at**, in their own browser, and shows which FTNSS gyms are nearby. It is a discovery
surface. It is not a checkout, and it does not scrape.

Two properties of this repo differ from every other FTNSS repo, and they drive everything below.

**1. The page is hostile.** Extension code runs inside third-party pages. Every byte of DOM,
structured data, URL and text it reads is attacker-controlled input, read in a context that holds
extension privileges. There is no "trusted page".

**2. This repository becomes public.** It is private today and goes public at the v1 release, **with
its full history**. A secret committed today is a secret published later; removing it in a subsequent
commit does not remove it. Write every commit as though it is already public, because it will be.

## The promise the code has to keep

The product's central claim is that this extension **cannot** see your browsing history — enforced
architecturally, not by policy. Four properties carry that claim:

1. Narrow, named host permissions. Never `<all_urls>`, never a wildcard TLD pattern.
2. The URL, hostname, page title and page content never leave the browser.
3. Coordinates are rounded to 250m cells **at the outbound boundary** before transmission.
4. The source is published, so any of the above can be checked rather than believed.

A change that erodes one of these is the most serious thing that can land here, including when it
looks like a harmless convenience. "It's only in the error path" is where these leaks actually live.

## Code Review Rules

Rules for an automated reviewer on this repo.

**Be adversarial, not descriptive.** Do not summarise the diff. Try to *break* it: find the page,
input, or state where it does the wrong thing. Report only defects you can justify. Prefer three real
findings over twenty observations.

**Do not assert what a third-party site publishes.** What Booking.com or Airbnb actually serves in
their structured data is *measured*, not deduced. If a finding depends on it, mark it UNVERIFIED and
state the assumption. This applies to markup shape, coordinate availability and address precision
alike.

### Privacy — the P0 class in this repo
- **Nothing identifying the page may leave the browser.** No URL, hostname, page title, page content,
  referrer, or search terms — in any request, log, telemetry, crash report, or query string.
- **Trace the failure paths, not the happy path.** Error handlers, `catch` blocks, retry logic and
  debug logging are where leaks are actually written. A `console.error(err)` that includes a page
  object is a leak the moment any logger ships those.
- **Rounding happens at the outbound boundary**, in one place that no caller can bypass. Rounding
  performed by each caller is a defect even while every current caller happens to do it correctly.
- **No third-party analytics, ad, telemetry or error-reporting SDK. Ever.** This is how nearly every
  history-leaking extension became one — usually via an SDK nobody fully read. Any new runtime
  dependency is at least P1 and must be justified in the PR.

### Permissions
- Any growth of `host_permissions`, `matches`, or `permissions` in the manifest is a finding.
  `<all_urls>` or a wildcard TLD is an automatic **P0**.
- A new named domain is **P1** unless the PR carries an explicit decision record justifying it.
  Widening permissions forces every existing user to re-accept, and some fraction never will.
- Site match patterns must cover the **ccTLD variants** of a listed domain, or the extension silently
  fails for non-English users. Partial coverage of a listed site is a bug, not a gap.

### Hostile-page input
- Page-supplied data is untrusted. Flag `innerHTML` / `outerHTML` / `insertAdjacentHTML` and any
  unsanitised injection into the panel. Script injection into an *extension* context is a P0, not an
  XSS footnote.
- JSON-LD and other structured data must be **shape-validated** after parsing. A page can publish any
  JSON it likes, including deeply nested or prototype-polluting objects.
- Messages crossing content script → background service worker must validate **both** the sender and
  the payload shape. A content script lives inside a hostile page and is never trusted.

### Truthfulness to the user
- **Absence is not a negative.** If a read fails or returns nothing, the panel must say it could not
  read the page. An empty panel is indistinguishable from "FTNSS has no gyms here" — a false
  statement about our own supply, made at the worst possible moment. Treat a violation as **P0**.
- **Never render precision we do not have.** Some sites expose only an approximate area by design. A
  precise distance derived from an approximate read is a confidently-wrong answer, which is worse
  than a visible failure. Approximate reads must be visibly marked as such.

### Secrets and internals
- No key, token, backend project URL, storage bucket name, database function name, or internal
  hostname in any tracked file — **including in a comment, a fixture, or a test**. The history
  publishes.
- Configuration comes from the environment at build time. `.env.example` carries placeholders only.

### Output
- Report only **P0** (privacy leak / security hole / a false statement shown to the user) and **P1**
  (a real bug on a plausible path). No style, naming, or preference. If it would be P2, omit it.
- Each finding: `file:line`, severity, the concrete failure scenario, and a specific fix.
- If nothing qualifies, reply with exactly: `No blocking issues found.`

## Working conventions

- One feature per branch, cut from `main`, small enough to review in a single pass.
- Self-review the full diff before opening a PR.
- Never commit anything you would not want published, in any commit, at any point.
