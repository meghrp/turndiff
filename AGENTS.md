# Contributing to turndiff

turndiff is a local Git review tool built with Bun, TypeScript, and React. Read the README for commands, data storage, and the source layout.

- Inspect the callers and nearby tests before changing behavior.
- Keep snapshots isolated from the user's branches, index, and stash. Use scratch Git repositories for experiments.
- Keep repository content and reviews local. The server must listen only on `127.0.0.1`.
- Run `bun install --frozen-lockfile`, `bun run check`, and `bun run build`.
- For UI changes, run `bunx --no-install playwright-core install chromium` and `bun run e2e`. `PLAYWRIGHT_CHANNEL=chrome` uses installed Chrome instead.
- Add a reproduction or behavior test for bug fixes. Keep changes focused.
- Stop temporary review servers when verification is complete.
