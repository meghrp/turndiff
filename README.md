# turndiff

Review what an agent did this turn, or what one branch of a git-spice stack changes, and send line comments back to the agent.

Two problems it fixes:

- **Turn diffs polluted by rebases.** Harness diff panels compare worktree snapshots. If the agent rebases or restacks mid-turn, every upstream commit shows up as "the agent's change". turndiff detects that the merge-base with the parent branch moved, replays the pre-turn state onto the new base with `git merge-tree`, and diffs from there. Only the turn's own edits remain.
- **Stack diffs that include the whole stack.** Most tools diff a branch against `main`. turndiff reads git-spice's metadata (`refs/spice/data`) and diffs each branch against its own parent, like the GitHub PR view does.

Comments and a decision go back to the agent as markdown on stdout, the same contract as plannotator: the CLI waits, the reviewer works in the browser, the agent reads the result.

## Install

Requires [Bun](https://bun.sh) and git 2.38+.

```bash
git clone <this repo> ~/Projects/turndiff
cd ~/Projects/turndiff
bun install
bun link            # puts `turndiff` on PATH via ~/.bun/bin
turndiff install    # Claude Code hooks (UserPromptSubmit + Stop) and the review skill
```

`turndiff install` edits `~/.claude/settings.json` (backup written next to it) and symlinks `skills/turndiff-review` into `~/.claude/skills`. Hooks take effect in new Claude Code sessions, including sessions driven by other harnesses on top of Claude Code (T3 Code, the Agent SDK).

## Use

```bash
turndiff review                     # latest turn; UI opens in the browser, CLI waits for feedback
turndiff review --branch            # current branch vs its git-spice parent
turndiff review --branch --worktree # include uncommitted changes
turndiff review --from 2 --to 5     # cumulative diff across turns
turndiff diff --turn 3              # raw patch on stdout
turndiff turns                      # what was captured
turndiff stack                      # git-spice stack with parents and PR numbers
turndiff clean --keep 5             # drop old sessions and their refs
```

In the UI, click a line number (drag for a range) to comment. Draft text autosaves; Ctrl/⌘↵ adds the comment. Close a draft to resume it later from the saved-drafts bar. Sending asks whether to include or discard unfinished comments, then lets you choose a review decision.

Drafts, comments, notes, and viewed-file progress are saved under `<git-common-dir>/turndiff/drafts/`, scoped to the worktree and selected turn or branch. They survive browser reloads and review-server restarts, even when the port changes. A browser backup also helps recover interrupted saves. Cancellation keeps your drafts; successful submission clears the submitted scope.

New code produces a **New changes available** banner instead of replacing an active review. Loading it reopens changed files and flags affected comments. Check those comments and explicitly keep their original context or replace them with comments on the new code. Feedback preserves the original snippets and identifies outdated context for the agent.

Use file search, **Unviewed only**, and **Next unviewed** to work through large reviews. The turns and files panels can be collapsed; drag their edges or focus an edge and use arrow keys to resize. Narrow windows collapse them automatically. Browser Back/Forward restores previous scopes. The left sidebar supports shift-clicking turns to review a range. A yellow banner marks restacks.

The review server runs detached and survives the agent's shell timeout. `turndiff review` reattaches to a running server; `turndiff stop` kills it.

## How turn capture works

Hooks snapshot the worktree (tracked and untracked, honoring `.gitignore`) into a commit parented on `HEAD` at the start and end of each turn. Snapshots live under `refs/turndiff/<session>/<turn>/{pre,post}`, never in your branches or index. Session metadata lives in `<git-common-dir>/turndiff/`. On a 76k-file monorepo a snapshot costs about two seconds.

For a turn from checkpoint `A` to `B` with parent branch `P`:

```
B0 = merge-base(A, P);  B1 = merge-base(B, P)
if B0 == B1:   diff A B
else:          T = merge-tree --write-tree --merge-base=B0 B1 A;  diff T B
```

Conflicts during the replay are rare and shown as conflict markers, with a warning in the banner.

## Layout

```
src/cli.ts            commands
src/git/              exec wrapper, git-spice reader, checkpoints + hook handler, diff engine
src/server/           Bun HTTP server, detached daemon, UI build + static serving
src/ui/               React UI on @pierre/diffs
src/feedback.ts       markdown the agent receives
skills/turndiff-review/  Claude Code skill
scripts/scenario.sh   scratch repo with a fake stack and a mid-turn restack
scripts/e2e.ts        drives the UI with Playwright against a running review
scripts/ux-e2e.ts     isolated UX regressions with a disposable repository and server
```

## Development

```bash
bun run typecheck
bun test
bun run e2e                                  # isolated UX suite; requires Chrome
bash scripts/scenario.sh                      # prints a scratch repo path and the expected diffs
cd "$(cat /tmp/turndiff-scratch-path)" && turndiff review --no-open --port 4765
bun scripts/e2e.ts http://127.0.0.1:4765/#turn/sess-1/1/1
```

The UI is rebuilt automatically when anything under `src/` is newer than `dist/ui/index.html`.
