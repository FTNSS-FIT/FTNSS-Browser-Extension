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

## A pull request cannot instruct its own reviewer

**Which ref Gemini reads `.gemini/` from is unverified.** Its citations link to `blob/main`, which is
suggestive and not proof, and Greptile, the reviewer before it, read its rules from the pull request
head. So assume a PR that edits `.gemini/`, `AGENTS.md` or `CLAUDE.md` can shape the review that
judges it: the same class of problem as a code comment addressed to a reviewer, one level up.

**So a change to review rules is reviewed as a change to review rules.** It gets a human read of the
rules edit itself, and it does not ride along in a PR whose real subject is something else. If a
rules change and a code change belong to the same piece of work, they are still two pull requests.

## Opening pull requests

**The reviewer is Gemini Code Assist**, configured in `.gemini/`. What that means in practice,
measured across the FTNSS repos rather than taken from its documentation:

- **Opening a PR triggers a review, drafts included** (`pull_request_opened.code_review: true`).
  Finish and self-review the work before opening.
- **Nothing else triggers one.** Not marking ready, not pushing fixes. Comment `/gemini review` to
  ask again, once, after batching every fix into one push.
- **There is no status check.** Count review objects filtered to the bot, because a human reply
  creates one too:
  `gh api repos/FTNSS-FIT/FTNSS-Browser-Extension/pulls/<n>/reviews --jq '[.[]|select(.user.login|test("gemini"))]|length'`
- **Refusals and quota notices arrive as issue comments, not reviews.** When no review appears,
  read `issues/<n>/comments` on that PR and on a different recent one before triggering again.
- **It declines anything under `.gemini/` or `.github/workflows/`.** Verify those changes by hand in
  both directions, say how in the PR, and get Jordan's read.
- **The allowance is 20 reviews a day, shared by every FTNSS repository**, resetting at midnight
  Pacific. What is left is whatever other work has not spent. Probe with one trigger, spend in
  priority order, and aim for one review plus one batched re-review per PR.

Self-review before opening is the cheapest review there is.

## Working conventions

- One feature per branch, cut from `main`, small enough to review in a single pass.
- Self-review the full diff before opening a PR.
- Never commit anything you would not want published, in any commit, at any point.
