// The follow-ups check, run the way CI runs it: a real process with PR_BODY in its environment.
//
// Both directions, because a check that only ever passes proves nothing — every "fail" case below
// is a body that must be rejected, and the suite was shown to go red against the unfixed version
// before this file was committed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./pr-follow-ups.mjs', import.meta.url));
const F = '```';

function run(body) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, PR_BODY: body },
    encoding: 'utf8',
  });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

const PASS = [
  ['plain none', 'Body text.\n\nFollow-ups: none'],
  ['one issue', 'Body.\n\nFollow-ups: #12'],
  ['two issues', 'Body.\n\nFollow-ups: #12, #13'],
  ['cross-repo shorthand', 'Body.\n\nFollow-ups: FTNSS-FIT/FTNSS-Admin-Web#300'],
  ['cross-repo URL', 'Body.\n\nFollow-ups: https://github.com/FTNSS-FIT/FTNSS-Admin-Web/issues/300'],
  ['bold label then none', 'Body.\n\n**Follow-ups:** none'],
  ['bold label before the colon', 'Body.\n\n**Follow-ups**: none'],
  ['whole line bold', 'Body.\n\n**Follow-ups: none**'],
  ['bold label then issues', 'Body.\n\n**Follow-ups:** #12, #13'],
  ['CRLF line endings', 'Body.\r\n\r\nFollow-ups: none\r\n'],
  ['fenced example, then the real line', `Form:\n${F}\nFollow-ups: #1234\n${F}\n\nFollow-ups: none`],
];

const FAIL = [
  ['no line at all', 'Body with nothing.'],
  ['empty body', ''],
  ['a value that is neither', 'Body.\n\nFollow-ups: maybe later'],
  ['a bare number without #', 'Body.\n\nFollow-ups: 12'],
  ['none, contradicted by a TODO', 'There is a TODO here.\n\nFollow-ups: none'],
  ['none, contradicted by bold none + prose', 'This is not yet fixed.\n\n**Follow-ups:** none'],
  ['only a fenced example', `Form:\n${F}\nFollow-ups: #1234\n${F}\nnothing else`],
  ['fenced example, real line junk', `${F}\nFollow-ups: #1234\n${F}\n\nFollow-ups: dunno`],
];

for (const [name, body] of PASS) {
  test(`accepts: ${name}`, () => {
    const r = run(body);
    assert.ok(r.ok, `should pass, got:\n${r.output}`);
  });
}

for (const [name, body] of FAIL) {
  test(`rejects: ${name}`, () => {
    const r = run(body);
    assert.ok(!r.ok, `should fail, got:\n${r.output}`);
  });
}
