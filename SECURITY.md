# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@ftnss.fit** rather than opening a public issue.

Include what you need to describe the problem: what you found, how to reproduce it, and what you
think the impact is. We will acknowledge your report and let you know what we intend to do about it.

We are a small team, so we will not promise a response time we cannot keep — but a security report
will not sit unread.

## What we are most interested in

Given what this extension does, these matter more than anything else:

- **Any path by which a URL, hostname, page title, or page content can leave the browser.** This
  includes error handlers, logs, and query strings. The extension is designed so this cannot happen;
  if you find a way, that is the most valuable report you can send us.
- **Any way a page can influence the extension beyond supplying data** — script execution in the
  extension context, injection into the panel, or a message a page can forge.
- **Any way coordinates could be transmitted at finer precision** than the rounding is meant to allow.
- Anything reachable from a hostile listing page that we have not anticipated.

## Not a vulnerability

- **The absence of a secret in this repository is intentional, not an oversight.** Configuration is
  injected at build time. The API a built extension queries serves only publicly-readable gym
  information and enforces its own access rules server-side.
- The list of sites the extension can read is deliberately public — it is in the manifest, and being
  able to read it is the point.

## Scope

This policy covers the code in this repository. Issues in the FTNSS website or apps should also go to
the address above, and we will route them.
