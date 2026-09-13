// The harness stylesheet cannot reach the consumer panel.
//
// popup.html carries the measurement harness's own <style> block, and it loads AFTER ftnss.css. When
// those rules were global they won the cascade at equal specificity and restyled the panel users see
// — 300px wide on a dark ground, with a white-on-orange button that fails contrast. Measured in
// headless Chrome on 2026-09-13; see the comment in popup.html.
//
// There is no DOM engine in this suite, deliberately (no dependencies), so this is a static check of
// the property that makes the leak impossible: every rule is scoped to the harness. The rendered
// behaviour was measured with a control when the fix was made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/popup/main.js', import.meta.url), 'utf8');

function selectorsIn(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0].trim())
    .filter(Boolean)
    .flatMap((group) => group.split(',').map((s) => s.trim()));
}

test('every inline style rule in popup.html is scoped to the harness', () => {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const selectors = blocks.flatMap(selectorsIn);
  // A parser that finds nothing would pass the assertion below vacuously.
  assert.ok(selectors.length >= 10, `found only ${selectors.length} selectors — the parser is broken, not the page`);
  const unscoped = selectors.filter((s) => !s.startsWith('#harness') && !s.startsWith('body.harness'));
  assert.deepEqual(unscoped, [], 'these rules would also style the consumer panel');
});

test('body.harness is applied in developer mode, and nowhere else', () => {
  const start = main.indexOf('if (prefs.devMode)');
  assert.ok(start >= 0, 'the developer-mode branch moved; update this test');
  const branch = main.slice(start, main.indexOf('return;', start));
  assert.match(branch, /document\.body\.classList\.add\('harness'\)/);
  assert.equal((main.match(/classList\.add\('harness'\)/g) ?? []).length, 1);
});
