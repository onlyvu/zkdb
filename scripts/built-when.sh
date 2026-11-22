#!/usr/bin/env bash
# What existed before the event (2 Nov 2026) and what was written during it, from git alone.
#   ./scripts/built-when.sh            # up to HEAD
#   ./scripts/built-when.sh 2a051c6    # up to a given commit
# "Hand-written" leaves out generated or vendored files: the bb-generated verifiers, compiled circuits and other
# JSON, the lockfile, proof fixtures, test vectors, images and the forge-std submodule.
set -euo pipefail
cd "$(dirname "$0")/.."
END=${1:-HEAD}
LAST_PRE=13ddb78   # last commit before 2 Nov 2026
EMPTY=$(git hash-object -t tree /dev/null)
GEN='(verifiers/|package-lock\.json|fixtures/|\.json$|test_vectors|foundry\.lock|forge-std|docs/media|\.gif$|\.png$|proof-meta)'
sum() { awk -v gen="$GEN" '$1 != "-" && $3 !~ gen { a += $1; d += $2; f++ } END { printf "%d files, +%d -%d lines\n", f, a, d }'; }

echo "Before the event: $(git rev-list --count $LAST_PRE) commits, $(git log -1 --format=%ad --date=short $LAST_PRE)"
git log --reverse --format='  %h %ad %s' --date=format:'%Y-%m-%d %H:%M' $LAST_PRE
printf '  hand-written: '; git diff --numstat "$EMPTY" $LAST_PRE | sum

echo
echo "During the event: $(git rev-list --count $LAST_PRE..$END) commits, $(git log --reverse --format=%ad --date=short $LAST_PRE..$END | head -1) to $(git log -1 --format=%ad --date=short $END)"
printf '  hand-written: '; git diff --numstat $LAST_PRE "$END" | sum
for d in circuits contracts/src contracts/test packages/zkdb packages/dashboard/src packages/dashboard/server packages/dashboard/scripts packages/dashboard/test docs; do
  printf '  %-28s ' "$d"; git diff --numstat $LAST_PRE "$END" -- "$d" | sum
done

echo
echo "Lines in $END by when they were written (git blame -w, hand-written text files):"
pre_ids=$(git rev-list $LAST_PRE | cut -c1-7 | paste -sd'|' -)
total=0; pre=0
while IFS= read -r f; do
  out=$(git blame -w --line-porcelain "$END" -- "$f" 2>/dev/null | grep -E '^[0-9a-f]{40} ' | cut -c1-7 || true)
  [ -z "$out" ] && continue
  total=$((total + $(grep -c . <<<"$out")))
  pre=$((pre + $(grep -cE "^($pre_ids)$" <<<"$out" || true)))
done < <(git ls-tree -r --name-only "$END" | grep -Ev "$GEN" | grep -Ev '^contracts/lib/' | grep -Ev '\.(woff2?|ico|svg)$')
echo "  $total lines, of which $pre from before 2 Nov ($((100 * pre / total))%)"
