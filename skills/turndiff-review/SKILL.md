---
name: turndiff-review
description: Open turndiff's browser review of your work (the checked-out branch against its git-spice parent by default, or a commit, the whole stack, or an agent turn) and act on the line comments the reviewer sends back. Use when the user says "review this", "let me review", "open turndiff", "review the branch", "review the stack", "review this turn", or when you have finished a change and want a human to check it before continuing.
---

# turndiff review

`turndiff review` opens the reviewer's browser on a diff of your work and waits until they submit. It then prints their comments as markdown, grouped by the branch each comment was written on, and exits.

## Write a guide first

When you have finished work on a branch, write a review guide for it before you start `turndiff review`. The reviewer reads it at the top of the branch and beside the code. Write one per branch: in a stack, run `turndiff guide` once for each branch you changed, each describing only that branch's diff.

```bash
turndiff guide - --branch <name> <<'EOF'
{
  "author": "<your model id>",
  "intent": "Why the branch exists, in one or two sentences.",
  "sections": [
    { "title": "Retry on 429", "overview": "What changed, why, what it implies, where the risk is.",
      "files": [{ "path": "src/client.ts", "summary": "Wraps fetch in a bounded retry." }] }
  ],
  "annotations": [
    { "path": "src/client.ts", "lines": [40, 52], "summary": "Backoff caps at 8s.",
      "rationale": "The upstream rate window is 10s; a longer wait would outlast the user's request." }
  ]
}
EOF
```

`lines` are 1-based in the file as it is now; add `"side": "old"` to point at removed code. All text is markdown. `turndiff guide --help` has the full format.

- Use 2 to 6 sections. Title each with a concept, never a filename.
- Order sections by reading order: the heart of the change first, its consequences next, glue last.
- Place every changed file in exactly one section.
- Annotate only where a reviewer would not see the reason from the code itself, and make the rationale say why, not what.
- Be honest about risk and uncertainty: name what you did not test and what you are unsure of.

The command checks the guide against the branch diff. When it exits 1, fix every listed problem and run it again. Warnings about unplaced files mean a file still needs a section.

## Run it in the background

Start it as a background command so the reviewer can take as long as they need. In Claude Code, call the Bash tool with `run_in_background: true`. The harness wakes you when the command exits, which is the moment the reviewer submits.

```bash
turndiff review                  # checked-out branch against its parent, including uncommitted changes
turndiff review --stack          # every branch of the stack, one section each
turndiff review --turn           # what your latest turn changed, branch by branch
turndiff review --branch <name>  # another branch of the stack
turndiff review --commit <rev>   # one commit
```

Then tell the user the review is open and end your turn. Do not poll the command, sleep, or start other work while you wait unless the user asked for it.

If a review tab is already open, turndiff moves it to the requested view instead of opening another one. Starting a new `turndiff review` retires any older one that is still waiting, so only the newest receives the feedback.

If your harness cannot run background commands, run `turndiff review --timeout 540` in the foreground with a 10-minute tool timeout, and run it again each time it prints `Still waiting`.

## Read the result

When the command exits, read its full output.

- **Markdown starting with `# Review feedback`.** Address every `### path:line` comment. Comments are listed under `## Branch <name>`. Fix each on that branch: check it out (`git-spice branch checkout <name>`), commit there, then restack the branches above it (`git-spice upstack restack`) before moving to the next branch. The fenced snippet is the exact code the reviewer pointed at, so use it to find the spot when a comment says the code has changed since. A comment that asks a question wants an answer in your reply, not necessarily a code change. When you are done, start `turndiff review` in the background again so the reviewer can re-check, unless the decision was "Approved".
- **`Superseded`.** A newer `turndiff review` took over. Do nothing.
- **`Still waiting for the reviewer`.** Only with `--timeout`. Run it again to keep waiting.
- **`the review server stopped`.** Ask the user what they want to do next.

## Rules

- Never invent feedback, and never assume approval before the command returns it.
- Do not run `turndiff stop` unless the user asks. The open review keeps its comments across restarts, but stopping closes the reviewer's tab connection.
