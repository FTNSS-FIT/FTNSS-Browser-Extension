<!--
  THE SUSPICION THIS FILE USED TO CARRY WAS WRONG, and the correction is worth keeping.

  Its predecessor (`.greptile/rules.md`) opened by naming ITSELF as the prime suspect for why
  Greptile ran twice on this repo and posted nothing both times. The install had been verified as
  `repository_selection: all` with `pull_requests: write`, and a per-repo config directory was the
  one thing unique to this repo — so the config looked like the variable.

  It was not. Admin established (2026-08-05) that Greptile had silently stopped reviewing because
  the ORG HAD EXCEEDED ITS MONTHLY FLEX USAGE LIMIT, while the status check went on reporting
  SUCCESS. The real message existed only in the body of a review object on a later PR. Every
  re-trigger sent in the meantime was another attempt against an already-exhausted limit.

  The rule that survives is stronger than the one we had, and it now applies to Gemini:

    A GREEN CHECK DOES NOT MEAN A REVIEW HAPPENED AT ALL. Count review objects. Never read the check.

  Pass condition, unchanged: a review object exists AND the delivered count matches the claim.

  ONE REFINEMENT TO THAT PASS CONDITION, measured 2026-08-05: `reviews=N` COUNTS HUMAN REPLIES
  TOO. An inline reply to a finding creates a review object, so a PR where somebody answered two
  findings reads `reviews=2` with zero reviewer activity. Filter by author before believing the
  count -- otherwise the metric we adopted BECAUSE the status check lied has the same failure mode.

    gh api repos/{o}/{r}/pulls/{n}/reviews --jq '[.[] | select(.user.login | test("gemini"))] | length'
-->

> 🔴 **THIS FILE IS THE ONE THE REVIEWER WILL NEVER READ BACK TO YOU.**
>
> Gemini declines to review anything under `.gemini/`. Its refusal blames "file types not
> supported", and that message is **wrong about its own behaviour** — the discriminator is the
> PATH, not the type: `CLAUDE.md` is reviewed, `.gemini/styleguide.md` is declined, and `.sql`,
> `.json`, `.ts` and `.css` are all fully supported. Two windows independently reached the same
> incorrect "markdown is unsupported" conclusion from an accurate reading of it.
>
> So the file with the most influence over every review in this repo is the only one with no
> safety net. A rule worded backwards here fails **silently and permanently** — every review after
> it looks normal and is subtly steered wrong.
>
> **Every change to this directory gets a human read. Do not request a review on a `.gemini/`-only
> PR: it will be declined, and a declined attempt still spends one of the org's shared daily runs.**

## Before trusting a review, ask "was it ever triggered?"

There are **three** ways a PR in this repo can look reviewed without having been properly reviewed,
and only one of them announces itself:

| what happened | what it leaves behind |
|---|---|
| reviewed with **no rules loaded** (no `.gemini/` directory) | nothing — a generic review is indistinguishable from an informed one |
| **not reviewed, quota exhausted** | an issue comment on *some* PRs, silence on others |
| **never triggered at all** — opened as a draft, and `ready_for_review` fires nothing | **no artifact whatsoever** |

So the question to ask is **"was it ever triggered?"**, not "why did the review not appear?" — the
third case has no failure to investigate, because nothing was ever asked for.

# Review rules — FTNSS Browser Extension

`AGENTS.md` → **Code Review Rules** is the authority for humans and for any agent working in this
repo. This file restates the highest-value rules inline rather than referencing it, because
**whether Gemini reads `AGENTS.md` is unverified.** Greptile demonstrably did — its findings cited
the file by name — and that conclusion does not carry across vendors.

This file is the one Gemini is documented to read, so this is where the rules have to be. A rule
that may or may not have loaded is worse than no rule: a generic review still looks like a review,
and the degradation is invisible.

## The defect classes that actually occur here

**Privacy is the P0 class.** The README makes claims a reader can check: narrow named-host
permissions, coordinates rounded to a 250m grid before anything is transmitted, exactly one file
permitted to reach the network, nothing sent until the user asks. **A change that makes a stated
promise untrue is more serious than a crash.** Flag any diff that widens what leaves the browser,
adds a network call outside `src/lib/proximity.js`, attaches credentials or an identifier to a
request, or leaves a claim in `README.md` that the code no longer keeps.

**Confident answers on insufficient evidence.** This is the failure the whole architecture is built
against: a wrong location stated confidently is worse than admitting the page could not be read.
Flag anywhere the code resolves ambiguity by guessing — picking the first of several candidates,
treating "we could not parse it" as "there is nothing there", or reporting an absence as conclusive
when it was measured from an unverified point.

**Truncating where it should reject.** A shortened display name is cosmetic. A shortened *path*,
*URL* or *identifier* is still syntactically valid and now points somewhere else. This has produced
a real bug in this repo. Treat any cap applied to a value with structure as a defect unless
exceeding it rejects.

**Two things made to look like one.** Identity, clustering and cross-source corroboration are all
places a hostile or merely busy page can merge two hotels into one answer. A shared country, a
shared city, a shared postcode in most markets, or a road name shared by two buildings are **not**
evidence of identity.

**Precision that the input cannot support.** Nothing here may render a number more precise than the
250m grid the query was rounded to. There is deliberately no `exact` precision value in the
codebase; `unknown` is not a licence to state a figure.

**Permission and manifest changes.** A one-line `host_permissions` or `optional_host_permissions`
edit reads as trivial in a diff and expands what the extension can reach. `permissions` must stay
`["storage"]` and `host_permissions` must stay absent unless the PR argues otherwise explicitly.

## Conventions

- Plain JavaScript, no dependencies, no build step — a new dependency needs an argument, not a line.
- Comments here carry the reasoning behind decisions that would otherwise look arbitrary. Removing
  the *why* is a real loss; flag it.
- Tests that assert current behaviour rather than intended behaviour pin bugs in place. If a diff
  changes an assertion to match new output, check which of the two it is.

## Not worth a comment

Formatting, subjective naming, and comment density — the density is deliberate.
