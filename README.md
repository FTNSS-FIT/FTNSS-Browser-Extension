# FTNSS Browser Extension

A small panel that appears while you are looking at a hotel or rental listing and tells you which
FTNSS gyms are nearby — without us ever seeing what you are browsing.

> **Status: pre-release.** This repository currently holds the **phase 1 measurement harness**, not
> the product. It exists to answer one question before anyone builds further: how often can a listing
> page's location actually be read? Nothing here has been published to a browser store.

## What this is, technically

**Plain JavaScript. No dependencies. No build step. No framework.** About 1,300 lines across 10
files. It loads unpacked and runs exactly as written.

That is deliberate. A dependency tree is an extension's attack surface, and it is also source that
anyone checking the privacy claim below would have to audit. "No build step" means what runs in your
browser is byte-for-byte what is in this repository.

```bash
npm test    # extractors against hostile input, plus the no-network and permission assertions
```

To run the harness: `chrome://extensions` → Developer mode → **Load unpacked** → select `src/`.

**Chrome only, today.** Firefox and Safari are real work, not a switch — see
[`ARCHITECTURE.md`](ARCHITECTURE.md) for what each would cost.

## The privacy claim, and how to check it yourself

The claim is that this extension **cannot** see your browsing history — because of how it is built,
not because of a promise in a policy document. Three files let you verify that in about ninety
seconds:

| Check | Where |
|---|---|
| Which sites it can read — a short, named list, never `<all_urls>` | [`src/manifest.json`](src/manifest.json) |
| That coordinates really are truncated before transmission | `toTransmittablePoint` in [`src/lib/geo.js`](src/lib/geo.js) |
| That there is no network code at all | [`tools/no-network.test.mjs`](tools/no-network.test.mjs) — it fails the build if any source file contains `fetch(` |

Four properties carry the claim:

1. **Narrow permissions.** A short list of named sites. It is technically incapable of reading any
   other page — a limit enforced by the browser, not by us.
2. **The URL never leaves your browser.** Not the address bar, not the page title, not the content.
   Our servers cannot reconstruct what you were looking at, because it was never sent.
3. **Coordinates are rounded before they are sent.** Cells about 1.1km across — plenty to answer "is
   there a gym near this hotel", uselessly coarse as a location trail. The grid is **latitude-aware**:
   a fixed number of decimal places is only ~1km near the equator and about 190m at 80°, so the
   longitude step is derived from the latitude.
4. **The source is public**, so none of the above has to be taken on trust.

### What it does not do

No payments and no card details — buying a pass hands off to the website. No third-party analytics,
advertising, or error-reporting SDKs, ever. No crawling: it reads the page you are already looking
at, on your machine, and the reading does not leave it.

## Reproducible builds

Every published version will be tagged at the exact commit it was built from. Today there is no build
step at all, which is the strongest form of that promise: the extension you load is the repository.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it runs, how it relates to the FTNSS platform, and where
  cross-browser support actually stands
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — the architectural decisions and why
- [`docs/PHASE-1-MEASUREMENT.md`](docs/PHASE-1-MEASUREMENT.md) — the measurement protocol
- [`AGENTS.md`](AGENTS.md) — the standards a change is held to

## Contributing

Issues and pull requests are welcome, though we may decline changes that do not fit the project's
direction. Anything affecting permissions, network requests, or dependencies will be reviewed
closely.

Security reports: see [`SECURITY.md`](SECURITY.md). Please do not open a public issue for a
vulnerability.

## Licence

[MIT](LICENSE).
