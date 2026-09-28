# turndiff

A local review tool for stacked branches and the agents that write them. It reads your git-spice stack, shows each branch against its parent the way a GitHub PR does, lets you step through single commits and commit ranges, and sends every line comment you leave, on any branch, back to the agent as one markdown review.

## What you can review

- **A branch** against its parent branch. For the checked-out branch this includes uncommitted changes when there are any.
- **A commit** or a **range of commits**, labeled with the branch each commit belongs to. A range can cross branches of one stack.
- **Uncommitted changes** against `HEAD`.
- **The entire stack**, one section per branch, parents first.
- **An agent turn**, or several, as what each branch gained during those turns.
- **Everything since your last review**, the same way.

Turn and since-review views compare each branch with its own earlier self. If the agent switches from `feat-b` to `feat-a` mid-turn, commits on both and restacks, you see what `feat-a` gained and what `feat-b` gained, and nothing from the restack. Harness turn diffs compare two worktree snapshots instead, so a branch switch shows up as one branch deleting the other's code.

## Comments

Select lines in the gutter to comment. A comment is attached to the exact file content it was written on (the blob id), so it appears in every view that shows that content: the branch view, the commit that last touched the file, the stack view. When the code under a comment changes, the comment is marked outdated and keeps its original snippet.

All comments in a worktree form one review, whichever branch or view you wrote them in. Submitting sends them to the waiting agent grouped by branch in stack order, with `git-spice` instructions to fix each on its own branch and restack. With no agent waiting, the UI copies the markdown so you can paste it anywhere.

Viewed marks are also attached to content: a file you marked viewed stays viewed in every view until its content changes.

## Install

turndiff needs [Bun](https://bun.sh) and git 2.40 or later. It reads git-spice metadata directly from `refs/spice/data`, so the `git-spice` binary is optional.

```bash
git clone <this repo> ~/Projects/turndiff
cd ~/Projects/turndiff
bun install
bun link            # puts `turndiff` on PATH via ~/.bun/bin
turndiff install    # Claude Code hooks for turn recording, and the turndiff-review skill
```

`turndiff install` adds `UserPromptSubmit` and `Stop` hooks to `~/.claude/settings.json` (it writes a backup next to it) and links `skills/turndiff-review` into `~/.claude/skills`. The hooks also fire in harnesses built on Claude Code, such as T3 Code and the Agent SDK. Without the hooks, everything except turn views works.

## Use

```bash
turndiff                       # open the UI on the checked-out branch
turndiff --stack               # or pick a starting view: --branch [name], --commit <rev>,
turndiff --range main..feat-b  #   --range <a>..<b>, --working, --turn [n], --turns 2-4, --since-review
turndiff review                # open the UI, wait for the review, print it (what the agent runs)
turndiff stop                  # stop this worktree's review server
turndiff clean --keep 5        # drop old recorded agent sessions; --all also removes v0 data
```

Each worktree gets its own review server, started in the background on first use and reused after that. It restarts on its own port when turndiff's code changes, so an open tab reconnects. `turndiff review --branch feat-a` moves an already open tab to that branch instead of opening a second one. `turndiff review` waits up to 9 minutes (`--timeout`), which keeps it under Claude Code's 10-minute Bash limit. Run it again to keep waiting.

## How turn comparison works

At each hook event turndiff records a snapshot: the tip of every stack branch, plus a commit of the worktree (tracked and untracked files, honoring `.gitignore`) parented on `HEAD`. The worktree commit stands in for the checked-out branch, so uncommitted work belongs to the branch it was written on. Snapshots live under `refs/turndiff/v1/` and never touch your branches, index or stash.

To compare snapshots `A` and `B`, turndiff takes each branch `X` with parent `P`:

```
a = X in A, b = X in B              # worktree commit if X was checked out, else the branch tip
base_a = merge-base(a, P in A)
base_b = merge-base(b, P in B)
old = a                             if base_a == base_b
old = merge-tree --merge-base=base_a base_b a   otherwise (the restack replay)
section X = diff(old, b)            # skipped when empty
```

A branch that did not exist in `A` shows its whole diff against its parent. The trunk contributes only uncommitted changes made while it was checked out, since commits on it cannot be told apart from pulled ones.

## Where data lives

- `<git-common-dir>/turndiff/v1/sessions/` and `snapshots/`: recorded agent turns, shared by all worktrees. Each server lists only its own worktree's sessions.
- `<worktree git dir>/turndiff/review.json`: the open review (comments, summary, viewed marks).
- `<worktree git dir>/turndiff/history/`: every submitted review with the markdown that was sent.
- `<worktree git dir>/turndiff/server.json`: the running server's port and pid.

## Layout

```
src/model.ts          types and HTTP API shared by the server and the UI
src/git/stack.ts      branches, parents and commits; the change fingerprint the UI polls
src/git/diff.ts       tree diffs as per-file changes with blob ids; worktree snapshots
src/git/views.ts      resolves a target (branch, commits, working, stack, turns) into sections
src/git/snapshots.ts  stack snapshots, hook recording, per-branch comparison
src/server/           HTTP server, review store, detached daemon, UI build
src/feedback.ts       the markdown the agent receives
src/ui/               React UI on @pierre/diffs
src/scenario.ts       scratch repo with a stack and a branch-switching, restacking agent turn
```

## Development

```bash
bun run typecheck
bun test                  # engine and server tests against the scenario repo
bun run e2e               # drives the UI in Chrome against the scenario repo
bun scripts/scenario.ts   # build a scenario repo and print its path
```

To try the UI by hand, build a scenario repo and run the server in the foreground with `cd "$(bun scripts/scenario.ts)" && bun ~/Projects/turndiff/src/cli.ts serve --port 4780`. The UI rebuilds when anything under `src/` is newer than `dist/ui/index.html`.
