#!/usr/bin/env node
// Bump the extension version, in both files, in one command.
//
//   npm run bump          patch: 0.2.0 -> 0.2.1
//   npm run bump minor    0.2.0 -> 0.3.0
//
// This exists for one practical reason: reloading an unpacked extension gives no confirmation that
// anything changed. Half a dozen times this session a fix was pushed, reloaded, and the old
// behaviour persisted — and there was no way to tell a failed reload from a failed fix. The version
// is shown in the popup, so "did my reload take?" is answerable at a glance instead of by guessing.

import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = new URL('../src/manifest.json', import.meta.url);
const PACKAGE = new URL('../package.json', import.meta.url);

const kind = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error(`usage: npm run bump [patch|minor|major]  (got "${kind}")`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const [major, minor, patch] = manifest.version.split('.').map(Number);
if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
  console.error(`manifest version is not semver: ${manifest.version}`);
  process.exit(2);
}

const next =
  kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

manifest.version = next;
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

// package.json follows the manifest, never the other way round: the manifest is what the browser
// reads, so it is the one that must be right.
const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'));
pkg.version = next;
writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`version ${next}`);
