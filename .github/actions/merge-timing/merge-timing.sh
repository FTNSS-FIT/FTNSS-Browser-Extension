#!/usr/bin/env bash
# Prints the "time in the queue" line for a merged PR (#996), for the Slack merge post:
#
#   :stopwatch: In the queue 3d · closed 2 issues: #812 (12d) · #830 (5h)
#
# PR time = merged_at − created_at. Issues = the PR's closingIssuesReferences (includes
# cross-repo `Closes FTNSS-FIT/<repo>#n`), each timed created_at → closed_at, or → merged_at
# when GitHub has not closed it yet (the merge event can beat the auto-close by seconds).
# Durations are ONE unit, the largest that fits, rounded down: 30d / 12h / 30m / <1m.
#
# Usage: merge-timing.sh <owner/repo> <pr-number>     (needs GH_TOKEN; prints one mrkdwn line)
#
# ⚠️ A failure here must never cost the merge post itself. On any API error it prints the PR
# time alone if it can, and nothing otherwise; the caller treats an empty line as "omit it".
set -uo pipefail

repo="$1"; num="$2"
owner="${repo%%/*}"; name="${repo#*/}"

dur() { # seconds -> 30d / 12h / 30m / <1m
  local s=$1
  if   [ "$s" -ge 86400 ]; then echo "$((s / 86400))d"
  elif [ "$s" -ge 3600 ];  then echo "$((s / 3600))h"
  elif [ "$s" -ge 60 ];    then echo "$((s / 60))m"
  else echo "<1m"; fi
}
epoch() { date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; }

# shellcheck disable=SC2016
q='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){
  createdAt mergedAt
  closingIssuesReferences(first:25){nodes{number createdAt closedAt repository{nameWithOwner}}}}}}'
# ⚠️ Not `if ! raw=$(…)`: GraphQL answers a PARTIAL failure with data AND errors, and gh exits
# non-zero on it. The usual partial failure is a `Closes FTNSS-FIT/<other-repo>#n` the workflow
# token cannot read (it is scoped to this repo): that issue comes back null and is dropped below,
# and the PR time and every readable issue still post.
raw=$(gh api graphql -f query="$q" -F o="$owner" -F n="$name" -F p="$num" 2>/dev/null) || true

pr=$(jq -c '.data.repository.pullRequest // empty' <<<"$raw" 2>/dev/null)
[ -n "$pr" ] || exit 0
created=$(jq -r '.createdAt' <<<"$pr"); merged=$(jq -r '.mergedAt // empty' <<<"$pr")
[ -n "$merged" ] || exit 0
m=$(epoch "$merged")
line=":stopwatch: In the queue $(dur $(( m - $(epoch "$created") )))"

parts=()
while IFS=$'\x1f' read -r inum icreated iclosed irepo; do
  [ -n "$inum" ] || continue
  end=$m; [ -n "$iclosed" ] && end=$(epoch "$iclosed")
  label="#$inum"; [ "$irepo" != "$repo" ] && label="${irepo#*/}#$inum"
  parts+=("$label ($(dur $(( end - $(epoch "$icreated") ))))")
done < <(jq -r '.closingIssuesReferences.nodes[]? | select(. != null) | [.number, .createdAt, (.closedAt // ""), .repository.nameWithOwner] | join("\u001f")' <<<"$pr")

if [ "${#parts[@]}" -gt 0 ]; then
  noun=issues; [ "${#parts[@]}" -eq 1 ] && noun=issue
  joined=$(printf ' · %s' "${parts[@]}"); joined=${joined# · }
  line="$line · closed ${#parts[@]} $noun: $joined"
fi
printf '%s\n' "$line"
