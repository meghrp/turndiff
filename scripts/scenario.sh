#!/usr/bin/env bash
# Build a scratch repo with a fake git-spice stack, run one agent turn that gets
# restacked mid-way, and check that turndiff hides the upstream noise.
set -euo pipefail
TD="${TD:-bun $(cd "$(dirname "$0")/.." && pwd)/src/cli.ts}"
R=$(mktemp -d -t turndiff-scratch)
echo "scratch repo: $R"
cd "$R"; git init -q -b main
git config user.email t@t; git config user.name t
printf 'line1\nline2\nline3\n' > a.txt; echo base > b.txt; git add -A; git commit -qm "c1"
echo more >> b.txt; git commit -qam "c2"
git checkout -qb feat-a; printf 'a1\na2\n' > feat_a.py; git add -A; git commit -qm "feat-a work"
git checkout -qb feat-b; printf 'def f():\n    return 1\n' > feat_b.py; git add -A; git commit -qm "feat-b work"
mk() { git hash-object -w --stdin; }
repo=$(printf '{"trunk":"main","remote":null}' | mk)
fa=$(printf '{"base":{"name":"main","hash":"%s"},"upstream":{"branch":"feat-a"}}' "$(git rev-parse main)" | mk)
fb=$(printf '{"base":{"name":"feat-a","hash":"%s"},"change":{"github":{"pr":{"number":42},"comment":{"url":"https://github.com/x/y/pull/42#issuecomment-1"}}}}' "$(git rev-parse feat-a)" | mk)
btree=$(printf '100644 blob %s\tfeat-a\n100644 blob %s\tfeat-b\n' "$fa" "$fb" | git mktree)
root=$(printf '100644 blob %s\trepo\n040000 tree %s\tbranches\n' "$repo" "$btree" | git mktree)
git update-ref refs/spice/data "$(git commit-tree "$root" -m spice)"
echo "--- stack"; $TD stack
printf '{"session_id":"sess-1","hook_event_name":"UserPromptSubmit","cwd":"%s","prompt":"add g() to feat_b and fix a.txt"}' "$R" | TURNDIFF_DEBUG=1 $TD hook
printf 'def f():\n    return 1\n\ndef g():\n    return 2\n' > feat_b.py; git commit -qam "add g"
perl -pi -e 's/line2/line2 fixed/' a.txt; git stash -q
git checkout -q main; echo upstream > upstream.txt; printf 'line1\nline2\nline3\nline4 from main\n' > a.txt; git add -A; git commit -qm "main moves"
git checkout -q feat-a; git rebase -q main; git checkout -q feat-b; git rebase -q feat-a; git stash pop -q
printf '{"session_id":"sess-1","hook_event_name":"Stop","cwd":"%s"}' "$R" | TURNDIFF_DEBUG=1 $TD hook
echo "--- turns"; $TD turns
echo "--- turn 1 diff (expect g() + a.txt line2 fix only)"; $TD diff --turn 1
echo "--- branch feat-b (expect feat_b.py only)"; $TD diff --branch feat-b | grep -E '^diff'
echo "--- branch feat-b --worktree (feat_b.py + a.txt)"; $TD diff --branch feat-b --worktree | grep -E '^diff'
echo "$R" > /tmp/turndiff-scratch-path
