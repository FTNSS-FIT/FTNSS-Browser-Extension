# FTNSS Browser Extension

A small panel that appears while you are looking at a hotel or rental listing and tells you which
FTNSS gyms are nearby — without us ever seeing what you are browsing.

> **Status: pre-release.** This repository is under active development and nothing has been published
> to a browser store yet. See [`docs/DECISIONS.md`](docs/DECISIONS.md) for the architecture and the
> reasoning behind it.

## The privacy claim, and how to check it yourself

The claim is that this extension **cannot** see your browsing history — because of how it is built,
not because of a promise in a policy document. Three files let you verify that in about ninety
seconds:

| Check | Where |
|---|---|
| Which sites it can read — a short, named list, never `<all_urls>` | `src/manifest.json` |
| That coordinates really are truncated before transmission | the rounding function at the network boundary |
| That nothing but a coordinate is ever sent | the single outbound request in the background worker |

Four properties carry the claim:

1. **Narrow permissions.** The extension declares a short list of named sites. It is technically
   incapable of reading any other page — a hard limit enforced by the browser, not by us.
2. **The URL never leaves your browser.** Not the address bar, not the page title, not the content.
   Our servers cannot reconstruct what you were looking at, because it was never sent.
3. **Coordinates are rounded before they are sent.** Roughly 1km of precision — plenty to answer "is
   there a gym near this hotel", uselessly coarse as a location trail.
4. **The source is public**, so none of the above has to be taken on trust.

### What it does not do

No payments and no card details — buying a pass hands off to the website. No third-party analytics,
advertising, or error-reporting SDKs, ever. No crawling: the extension reads the page you are already
looking at, on your machine, and the reading does not leave it.

## Reproducible builds

Every published version is tagged at the exact commit it was built from, and the build is a single
documented command, so anyone can build it and compare the result against what is in the store.

```bash
npm ci && npm run build
```

## Configuration

Configuration is injected at build time from the environment; see `.env.example`. There are no
credentials in this repository and none in a built extension — the API it queries serves only
publicly-readable gym information.

## Contributing

Issues and pull requests are welcome, though we may decline changes that do not fit the project's
direction. Anything affecting permissions, network requests, or dependencies will be reviewed closely
— see [`AGENTS.md`](AGENTS.md) for the standards a change is held to.

Security reports: see [`SECURITY.md`](SECURITY.md). Please do not open a public issue for a
vulnerability.

## Licence

[MIT](LICENSE).

<!-- smoke test: verifying the deploy-notify webhook reaches the consumer deployments channel -->
