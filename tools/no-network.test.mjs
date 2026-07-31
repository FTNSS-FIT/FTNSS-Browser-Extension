// The whole project rests on "nothing about the page leaves the browser".
//
// Phase 1 held that absolutely: NO network requests at all. The proximity panel ends that, because
// asking what is near a point requires asking someone. So the rule changes shape rather than
// relaxing: exactly ONE file may talk to a network, it is listed here by name, and every other file
// in src/ is held to the original absolute rule.
//
// ⚠️ THIS TEST FAILED TO FIRE WHEN THE FIRST REQUEST LANDED. `gymsNear` takes `fetchImpl = fetch`
// and calls `fetchImpl(...)`, and the pattern `\bfetch\s*\(` matches neither — the default has no
// parenthesis after it and the call site is a different identifier. A guard that can be walked past
// by renaming a variable is not a guard, and the walk-past was accidental, which is worse: the
// conversation this test exists to force did not happen because nothing prompted it.
//
// So the patterns now catch bare references too, not just calls.

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

/**
 * The ONE file permitted to reach the network. Adding to this list is the deliberate conversation
 * the header describes — it is not a formality, and a second entry should be argued for out loud.
 */
const NETWORK_ALLOWED = new Set(['src/lib/proximity.js']);

const FORBIDDEN = [
  // A BARE REFERENCE, not just a call. `const f = fetch` followed by `f()` was invisible to the
  // call-shaped pattern this replaced, and that is exactly how the first request got in.
  [/\bfetch\b/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\bnew\s+WebSocket\b/, 'WebSocket'],
  [/\bnew\s+EventSource\b/, 'EventSource'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\bchrome\.runtime\.sendNativeMessage\b/, 'sendNativeMessage'],
];

test('only the one allowed file performs a network request', () => {
  const offences = [];
  for (const file of sourceFiles(SRC)) {
    const relative = file.replace(SRC, 'src/');
    if (NETWORK_ALLOWED.has(relative)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(code)) offences.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(offences, [], `network calls found:\n${offences.join('\n')}`);
});

test('the allowlist names a file that exists', () => {
  // An allowlist entry for a renamed or deleted file silently exempts nothing and hides that the
  // exemption is stale — or, worse, matches a new file that later takes the old name.
  const present = new Set(sourceFiles(SRC).map((f) => f.replace(SRC, 'src/')));
  for (const allowed of NETWORK_ALLOWED) {
    assert.ok(present.has(allowed), `${allowed} is allowlisted for network access but does not exist`);
  }
});

test('the network file sends a rounded point and nothing else', () => {
  // A structural check to sit alongside the behavioural ones in proximity.test.mjs. Those prove
  // what today's code does; this proves the SHAPE that makes it auditable — a reader checking our
  // privacy claim should find one body literal built from one rounded point.
  const code = stripComments(readFileSync(join(SRC, 'lib/proximity.js'), 'utf8'));
  const bodies = code.match(/body:\s*JSON\.stringify\(([^)]*)\)/g) ?? [];
  assert.equal(bodies.length, 1, 'exactly one request body');
  assert.match(bodies[0], /\{\s*lat:\s*point\.lat,\s*lon:\s*point\.lon\s*\}/,
    'the body must be the rounded point, field by field — never a spread');
  assert.match(code, /credentials:\s*'omit'/, 'a coarse point must not travel with a session cookie');
  assert.ok(!/\.\.\./.test(bodies[0]), 'no spread into the request body');
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
  // Still absent, and now load-bearing in a second way: the proximity endpoint's origin is granted
  // at RUNTIME, for the one origin the person types in, via optional_host_permissions. A compiled-in
  // host would put an origin in the install prompt before anyone has decided which environment we
  // call — and a broad one, to cover the fact that the decision is still open. (DECISIONS.md 15.)
  assert.equal(manifest.host_permissions, undefined, 'host_permissions must stay absent');
  assert.ok(
    Array.isArray(manifest.optional_host_permissions),
    'the endpoint origin is granted at runtime, so optional_host_permissions must exist',
  );

  const patterns = [
    ...manifest.content_scripts.flatMap((c) => c.matches),
    ...manifest.web_accessible_resources.flatMap((w) => w.matches),
  ];

  for (const pattern of patterns) {
    assert.ok(pattern !== '<all_urls>', 'manifest must never request <all_urls>');
    // A wildcard TLD ("*://*.airbnb.*/*") reads as a short list and behaves like a long one.
    assert.ok(!/\*\.\*|\.\*\/|\*:\/\/\*\//.test(pattern), `over-broad host pattern: ${pattern}`);
  }

  // STORAGE AND NOTHING ELSE. `activeTab` was added and then removed: messaging a content script
  // that the manifest already injects needs no permission at all, so it bought nothing and widened
  // the boundary to every tab the toolbar is clicked on. Any growth here fails the build.
  assert.deepEqual(
    manifest.permissions,
    ['storage'],
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

  // The content script must not WRITE anywhere either. It answers questions; it does not publish.
  // A stored reading is what allowed one listing's coordinates to be shown for another, and the
  // cheapest way to keep that gone is to make storing impossible from here.
  for (const pattern of [/chrome\.storage/, /sendMessage/]) {
    assert.ok(!pattern.test(content), `content script must not publish state: ${pattern}`);
  }
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const exposed = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.ok(!exposed.some((r) => r.startsWith('panel/')), 'no panel is exposed to the page');
});
