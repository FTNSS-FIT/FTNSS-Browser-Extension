// PR follow-ups check. Every PR states what it leaves undone, as GitHub issues, in ONE line:
//
//   Follow-ups: #12, #13        (or FTNSS-FIT/Repo#N, or a full issue URL)
//   Follow-ups: none
//
// Adopted fleet-wide on Jordan's instruction, 2026-09-13. The executable code below is an EXACT copy
// of FTNSS-FIT/FTNSS-Consumer-Web#1150 at b6766ac (2026-09-13T16:40:35Z), so the two repositories
// can be diffed rather than compared by eye. That PR was still open when this was copied. If it
// changes, re-sync this file; do not let the copies drift into two dialects of one rule.
//
// ⚠️ An earlier draft of this file carried its own fix for `**Follow-ups:** none`, which failed
// against #1150 at a6c597e. #1150 fixed the same case in 85d9dea eighteen minutes later, and went
// further: `~~~` fences, indented code blocks, and exactly one label line. A claim about someone
// else's open PR is a claim about one commit, so the ref is written down here.
//
// WHY THIS REPO NEEDED IT, measured: of 20 merged PRs, NONE carried a follow-ups line, and the work
// they left behind lived in PR bodies, a gitignored HANDOFF.md, and two Greptile summaries that
// described live defects nobody tracked.
//
// Reads PR_BODY from the environment — set from the event payload by the workflow and never
// interpolated into a shell command, because a PR body is attacker-controlled text.

const body = process.env.PR_BODY ?? "";

// Fenced code blocks are EXAMPLES, never the answer. The first version matched the
// first `Follow-ups:` line anywhere, so a PR that showed the format in a ``` block
// passed on the example line (it passed its own PR, #1150, that way). Strip fences
// first, then take the LAST real line, which is where the template asks for it.
// Both fence styles: ``` and ~~~ (Business-Web: a ~~~ block was still read as the line).
const unfenced = body.replace(/(```|~~~)[\s\S]*?\1/g, "");
// Bold is how the label is usually typed: `**Follow-ups:** none`. The `**` can sit
// before the colon, after it, or both (Business-Web caught the after-colon case,
// which read the value as "** none" and failed a correct PR).
// At most THREE leading spaces: four spaces or a tab is a Markdown INDENTED code block,
// i.e. an example, and `^\s*` let it count as the real line (Admin-Web found this the hard
// way: its PR quoted the rule in an indented block and went green on the example's value).
// Whitespace is allowed only AFTER actual bold markers, so ` {0,3}` + zero stars cannot
// hand the fourth space to a later `\s*` and readmit indentation.
const LABEL = /^ {0,3}(?:\*+[ \t]*)?follow-?ups[ \t]*\**[ \t]*:[ \t]*\**[ \t]*/i;
const lines = unfenced.split(/\r?\n/).filter((l) => LABEL.test(l));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  console.error("\nAdd one line to the PR body, e.g.\n  Follow-ups: #1234\nor\n  Follow-ups: none");
  process.exit(1);
};

if (lines.length === 0) fail("No `Follow-ups:` line in the PR body.");
// EXACTLY one. Taking the last of several let `Follow-ups: #1` then `Follow-ups: none`
// pass on the contradiction (Consumer-Mobile caught it).
if (lines.length > 1) fail(`Found ${lines.length} \`Follow-ups:\` lines; keep exactly one (outside code blocks).`);
const line = lines[0];

const value = line.replace(LABEL, "").replace(/\**\s*$/, "").trim();
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
