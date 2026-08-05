# Review rules — FTNSS Browser Extension

`AGENTS.md` → **Code Review Rules** is the authority. This file restates the highest-value rules
inline, because Greptile's own documentation says configuration files are read but does **not**
promise that referenced files are auto-detected — and a rule that may or may not have loaded is
worse than no rule, since a generic review still looks like a review.

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
