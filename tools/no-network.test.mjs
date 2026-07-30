// The whole project rests on "nothing about the page leaves the browser". In phase 1 that is
// absolute: the harness makes NO network requests at all.
//
// "We didn't add one" is not evidence, and the leak everyone actually ships arrives later, in a
// hurry, inside an error handler. So this is asserted mechanically over the source, and it fails
// the build the first time someone adds a call — including in a catch block, including "just for
// debugging". If a future phase genuinely needs a request, this test has to be edited deliberately,
// which is exactly the conversation that should happen before the first one lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

/** Strip comments so prose about networking does not trip the scan. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FORBIDDEN = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\bnew\s+WebSocket\b/, 'WebSocket'],
  [/\bnew\s+EventSource\b/, 'EventSource'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\bchrome\.runtime\.sendNativeMessage\b/, 'sendNativeMessage'],
];

test('no source file performs a network request', () => {
  const offences = [];
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(code)) offences.push(`${file.replace(SRC, 'src/')}: ${label}`);
    }
  }
  assert.deepEqual(offences, [], `network calls found:\n${offences.join('\n')}`);
});

test('no source file renders untrusted content as markup', () => {
  // Page text reaches the panel. Any of these turns "displaying a hostile string" into "executing
  // it", in a context holding extension privileges.
  const offences = [];
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/]) {
      if (pattern.test(code)) offences.push(`${file.replace(SRC, 'src/')}: ${pattern}`);
    }
  }
  assert.deepEqual(offences, []);
});

test('the manifest asks for narrow permissions and never <all_urls>', () => {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  // host_permissions is deliberately ABSENT: for a static content script, `matches` already
  // authorises injection, while host_permissions would additionally grant cross-origin request
  // capability that a harness making no requests must not hold. Assert it stays absent.
  assert.equal(manifest.host_permissions, undefined, 'host_permissions must stay absent');

  const patterns = [
    ...manifest.content_scripts.flatMap((c) => c.matches),
    ...manifest.web_accessible_resources.flatMap((w) => w.matches),
  ];

  for (const pattern of patterns) {
    assert.ok(pattern !== '<all_urls>', 'manifest must never request <all_urls>');
    // A wildcard TLD ("*://*.airbnb.*/*") reads as a short list and behaves like a long one.
    assert.ok(!/\*\.\*|\.\*\/|\*:\/\/\*\//.test(pattern), `over-broad host pattern: ${pattern}`);
  }

  // activeTab is granted per-invocation on a toolbar click, for that tab only — see
  // docs/DECISIONS.md 12. Any addition beyond these two is a decision, not a detail.
  assert.deepEqual(
    manifest.permissions,
    ['storage', 'activeTab'],
    'permissions must not grow without a decision record',
  );
});

test('no extension UI is injected into the page', () => {
  // The recorder lives in the popup, which the page cannot hide, move, click-jack or keylog. If a
  // content script ever starts building UI again, that whole class of problem comes back — three
  // review rounds found three separate ways to subvert an in-page panel before it was moved out.
  const content = stripComments(readFileSync(join(SRC, 'content.js'), 'utf8'));
  for (const pattern of [/createElement/, /attachShadow/, /appendChild/, /\.style\b/]) {
    assert.ok(!pattern.test(content), `content script must not build UI: ${pattern}`);
  }
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const exposed = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.ok(!exposed.some((r) => r.startsWith('panel/')), 'no panel is exposed to the page');
});
