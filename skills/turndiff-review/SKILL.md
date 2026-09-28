---
name: turndiff-review
description: Open turndiff's browser review of the current agent turn (or a git-spice branch) and act on the line comments the reviewer sends back. Use when the user says "review this turn", "let me review", "open turndiff", "send me the diff", "review the branch", or when you have finished a change and want a human to check it before continuing.
---

# turndiff review

turndiff shows the reviewer a diff that contains only your work: the current turn's changes (rebase and restack noise removed) or one branch of a git-spice stack against its parent. The reviewer leaves line comments and a decision in the browser; the CLI prints them as markdown.

## Run

Default (latest turn, falls back to the current branch with uncommitted changes):

```bash
turndiff review
```

Other scopes:

```bash
turndiff review --branch                 # current branch vs its git-spice parent, committed only
turndiff review --branch --worktree      # same, including uncommitted changes
turndiff review --from 2 --to 4          # several turns cumulatively
turndiff review --branch <name>          # another branch of the stack
```

Run it with the Bash tool at the maximum timeout (600000 ms). The command waits up to 9 minutes by default.

## Read the result

- **Feedback markdown** starting with `# Review feedback`: address every `### file:line` comment. The fenced snippet under each heading is the exact code the reviewer pointed at, so use it to locate the spot if the file has changed since. Then, if the decision was "Changes requested", run `turndiff review` again so the reviewer can re-check.
- **`Still waiting for the reviewer`**: the reviewer has not submitted. The server is still up. Run `turndiff review` again to keep waiting. Do not start other work in the meantime unless the user asked you to.
- **`Review cancelled`**: the reviewer closed the review without feedback. Ask what they want to do next.

## Rules

- Never fabricate feedback or assume approval when the command has not returned it.
- Do not run `turndiff stop` unless the user asks; it discards the reviewer's open session.
- The review server stays up across your tool calls. Re-running `turndiff review` reattaches, it does not open a second browser tab.
