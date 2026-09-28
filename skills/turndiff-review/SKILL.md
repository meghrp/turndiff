---
name: turndiff-review
description: Open turndiff's browser review of your work (the checked-out branch against its git-spice parent by default, or a commit, the whole stack, or an agent turn) and act on the line comments the reviewer sends back. Use when the user says "review this", "let me review", "open turndiff", "review the branch", "review the stack", "review this turn", or when you have finished a change and want a human to check it before continuing.
---

# turndiff review

`turndiff review` opens the reviewer's browser on a diff of your work and blocks until they submit. Their comments come back on stdout as markdown, grouped by the branch each comment was written on.

## Run

Run it with the Bash tool at the maximum timeout (600000 ms). It waits up to 9 minutes.

```bash
turndiff review                  # checked-out branch against its parent, including uncommitted changes
turndiff review --stack          # every branch of the stack, one section each
turndiff review --turn           # what your latest turn changed, branch by branch
turndiff review --branch <name>  # another branch of the stack
turndiff review --commit <rev>   # one commit
```

If a review tab is already open, turndiff moves it to the requested view instead of opening another one.

## Read the result

- **Markdown starting with `# Review feedback`.** Address every `### path:line` comment. Comments are listed under `## Branch <name>`. Fix each on that branch: check it out (`git-spice branch checkout <name>`), commit there, then restack the branches above it (`git-spice upstack restack`) before moving to the next branch. The fenced snippet is the exact code the reviewer pointed at, so use it to find the spot when a comment says the code has changed since. After addressing everything, run `turndiff review` again if the decision was "Changes requested".
- **`Still waiting for the reviewer`.** The reviewer has not submitted yet and the server is still running. Run `turndiff review` again to keep waiting. Do not start other work in the meantime unless the user asked you to.
- **`the review server stopped`.** Ask the user what they want to do next.

## Rules

- Never invent feedback, and never assume approval before the command returns it.
- Do not run `turndiff stop` unless the user asks. The open review keeps its comments across restarts, but stopping closes the reviewer's tab connection.
