// PR follow-ups check. Every PR states what it leaves undone, as GitHub issues, in ONE line:
//
//   Follow-ups: #12, #13        (or FTNSS-FIT/Repo#N, or a full issue URL)
//   Follow-ups: none
//
// Adopted fleet-wide on Jordan's instruction, 2026-09-13, from FTNSS-FIT/FTNSS-Consumer-Web#1150 —
// kept deliberately close to that version so the repos can be compared line by line. The one
// intentional difference is the bold-label fix marked below.
//
// WHY THIS REPO NEEDED IT, measured rather than assumed: of 20 merged PRs, NONE carried a
// follow-ups line, and the work they left behind lived in PR bodies, a gitignored HANDOFF.md, and
// two Greptile summaries that flagged live defects nobody tracked (#20's stylesheet, #22's
// bare-listing hole). Work that lives only in a PR body is not looked at again.
//
// FAILS when there is no `Follow-ups:` line, when the line is neither `none` nor an issue
// reference, or when it says `none` while the body describes outstanding work. Fenced code blocks
// are ignored for both, so a PR that shows the format as an example cannot pass on the example.
//
// Reads PR_BODY from the environment — set from the event payload by the workflow and never
// interpolated into a shell command, because a PR body is attacker-controlled text.
const body = process.env.PR_BODY ?? "";

// Fenced code blocks are EXAMPLES, never the answer. The first version matched the
// first `Follow-ups:` line anywhere, so a PR that showed the format in a ``` block
// passed on the example line (it passed its own PR, #1150, that way). Strip fences
// first, then take the LAST real line, which is where the template asks for it.
const unfenced = body.replace(/```[\s\S]*?```/g, "");
const line = unfenced
  .split(/\r?\n/)
  .filter((l) => /^\s*\**\s*follow-?ups\s*\**\s*:/i.test(l))
  .pop();
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  console.error("\nAdd one line to the PR body, e.g.\n  Follow-ups: #1234\nor\n  Follow-ups: none");
  process.exit(1);
};

if (!line) fail("No `Follow-ups:` line in the PR body.");

// Markdown bold is stripped from BOTH sides of the colon and from the end. The reference version
// only allowed `**` before the colon, so `**Follow-ups:** none` — the natural way to bold a label —
// yielded the value "** none" and failed a correct PR, while `**Follow-ups:** #12` passed only by
// accident (the issue regex does not anchor). Found by running both directions, not by reading.
const value = line
  .replace(/^\s*\**\s*follow-?ups\s*\**\s*:\s*\**/i, "")
  .replace(/\**\s*$/, "")
  .trim();
const issueRef = /(^|[\s,(])#\d+\b|github\.com\/FTNSS-FIT\/[\w.-]+\/issues\/\d+|\bFTNSS-FIT\/[\w.-]+#\d+/i;
const isNone = /^none\.?$/i.test(value);

if (!isNone && !issueRef.test(value)) {
  fail(`\`Follow-ups:\` must be \`none\` or list issues (#123 or an issue URL). Found: "${value}"`);
}

if (isNone) {
  // Outstanding-work language elsewhere in the body contradicts "none". Checked on
  // the body WITHOUT the Follow-ups line itself and without fenced code blocks, so a
  // quoted command or this check's own wording does not trip it.
  const prose = unfenced
    .split(/\r?\n/)
    .filter((l) => l !== line)
    .join("\n");
  const outstanding = /\b(follow-?up work|TODO|not yet (done|built|fixed|implemented)|still (owed|outstanding|open)|out of scope (here|for this pr)|separate (pr|issue|change)|left for later)\b/i;
  const m = prose.match(outstanding);
  if (m) fail(`Body says "Follow-ups: none" but also mentions outstanding work ("${m[0]}"). File an issue and link it.`);
}

console.log(`✓ Follow-ups: ${value}`);
