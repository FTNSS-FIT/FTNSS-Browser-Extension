<!--
  WHY THIS FILE EXISTS, AND WHAT IT IS NOT NEEDED FOR.

  Greptile reads `AGENTS.md` and `CLAUDE.md` from a repo WITHOUT any `.greptile` config — verified
  in Admin-Web, which has no `.greptile` directory and whose reviews cite AGENTS.md directly with a
  link to the file on `main`. So the rules would load without this directory, and I was wrong to
  infer otherwise from Greptile's documentation, which says configuration files are read but does
  not mention auto-detection.

  This directory was also briefly suspected of causing Greptile to post nothing on this repo. It was
  not: a zero-finding run produces no visible artifact anywhere in the org, which is normal.

  What it still buys is the `instructions` block in config.json — repo-specific weighting that no
  amount of reading AGENTS.md conveys, because it says what to look for FIRST rather than what the
  rules are. That is worth keeping. The file list is belt-and-braces.

  ⚠️ ONE RISK WORTH KNOWING, UNVERIFIED: Greptile appears to read these files from the PR HEAD. If
  so, a pull request that edits AGENTS.md, CLAUDE.md or this file can influence the review judging
  it. Codex was pinned against that by resolving rules from the default branch; whether Greptile is
  has not been established. Until it has, treat a PR that changes review rules as one needing human
  eyes on the rules change itself, not just on the code.
-->
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
