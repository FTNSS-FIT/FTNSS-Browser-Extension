// Every named import must actually be exported by the module it names.
//
// This exists because it happened: the popup imported `migrateAwayLocalCohort` from storage.js while
// storage.js did not export it. The whole module then fails to load, so the popup sat at "Loading…"
// forever — and "forever loading" is indistinguishable from "still working it out", which is the
// silent-failure shape this project has spent most of its review rounds eliminating everywhere else.
//
// Nothing else caught it. The unit tests import the extractors and geo directly and never touch the
// popup; syntax checks parse each file in isolation and a missing export is not a syntax error. The
// gap was between the files, so the check has to be too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Named exports declared in a file. Deliberately simple — this codebase has no export tricks. */
function exportsOf(code) {
  const names = new Set();
  for (const match of code.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** Static `import { a, b } from './x.js'` statements, with their specifiers. */
function importsOf(code) {
  const found = [];
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    found.push({ names, specifier: match[2] });
  }
  return found;
}

test('every named import resolves to a real export', () => {
  const problems = [];

  for (const file of sourceFiles(SRC)) {
    const code = readFileSync(file, 'utf8');
    for (const { names, specifier } of importsOf(code)) {
      // Only relative imports are ours to check; there are no package imports in this repo.
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      let targetCode;
      try {
        targetCode = readFileSync(target, 'utf8');
      } catch {
        problems.push(`${file.replace(SRC, 'src/')} imports missing module ${specifier}`);
        continue;
      }
      const available = exportsOf(targetCode);
      for (const name of names) {
        if (!available.has(name)) {
          problems.push(
            `${file.replace(SRC, 'src/')} imports { ${name} } from ${specifier}, which does not export it`,
          );
        }
      }
    }
  }

  assert.deepEqual(problems, [], `broken imports:\n${problems.join('\n')}`);
});

test('the popup imports only modules that exist and load', async () => {
  // storage.js and geo.js are the popup's dependencies. geo.js is pure and can be imported here
  // directly; storage.js references `chrome` only inside function bodies, so importing it is safe
  // and proves the module body evaluates.
  await assert.doesNotReject(() => import('../src/lib/geo.js'));
  await assert.doesNotReject(() => import('../src/lib/storage.js'));
});

test('every timing field the content script emits survives the export allowlist', () => {
  // An allowlist fails CLOSED, which is what we want — but it fails closed SILENTLY, so renaming a
  // field in the producer drops it with no error anywhere. That happened: `readinessUncertaintyMs`
  // was split into `navigationDelayMs` and `probeDelayMs`, the allowlist kept the old name, and both
  // new fields vanished on export. Nothing caught it — every test built its own fixtures, so only a
  // record exported from a real browser ever showed it.
  const content = readFileSync(join(SRC, 'content.js'), 'utf8');
  const storage = readFileSync(join(SRC, 'lib/storage.js'), 'utf8');

  const timingBlock = content.slice(content.indexOf('timing: {'), content.indexOf('provisional:'));
  const emitted = [...timingBlock.matchAll(/^\s{8}([A-Za-z0-9_]+)[,:]/gm)].map((m) => m[1]);
  assert.ok(emitted.length >= 3, `expected to find timing fields, found ${emitted.join(',')}`);

  const allowBlock = storage.slice(
    storage.indexOf('function exportableTiming'),
    storage.indexOf('const KNOWN_REASONS'),
  );
  for (const field of emitted) {
    assert.ok(
      allowBlock.includes(`${field}:`),
      `content.js emits timing.${field} but the export allowlist drops it`,
    );
  }
});

test('every storage helper a file uses is actually imported', () => {
  // The other test checks imports RESOLVE. This checks the reverse, which is the failure that
  // actually shipped: `cohortRecordFor` was used in the popup and never imported, so the popup threw
  // `cohortRecordFor is not defined` the moment someone pressed Log — after loading fine, looking
  // fine, and reading the page fine. A missing import is not a syntax error and not a resolution
  // error; it is a runtime error on one code path, which is the hardest kind to notice.
  const exportedByStorage = exportsOf(readFileSync(join(SRC, 'lib/storage.js'), 'utf8'));
  const problems = [];

  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('storage.js')) continue;
    const code = readFileSync(file, 'utf8');
    const imported = new Set(importsOf(code).flatMap(({ names }) => names));
    // Strip comments and strings so prose and error messages don't produce phantom uses.
    const body = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");

    for (const name of exportedByStorage) {
      const used = new RegExp(`\\b${name}\\s*\\(`).test(body);
      if (used && !imported.has(name)) {
        problems.push(`${file.replace(SRC, 'src/')} calls ${name}() without importing it`);
      }
    }
  }

  assert.deepEqual(problems, [], `missing imports:\n${problems.join('\n')}`);
});
