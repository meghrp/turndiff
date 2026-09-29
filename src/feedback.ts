// The markdown the agent receives: every comment, grouped by the branch it was
// written on, in stack order. Anchors are path:line so the agent can jump to
// the spot; the snippet pins the exact code in case the file has moved on.

import type { Comment, Decision } from "./model.ts";

const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  comment: "Comments only",
};

export interface FeedbackInput {
  decision: Decision;
  summary: string;
  comments: Comment[];
  outdated: ReadonlySet<string>;
  /** Branch names in stack order, parents first. */
  branchOrder: string[];
  prs: ReadonlyMap<string, number>;
  usesSpice: boolean;
}

export function formatFeedback(input: FeedbackInput): string {
  const { comments } = input;
  const groups = new Map<string | null, Comment[]>();
  for (const c of comments) groups.set(c.origin.branch, [...(groups.get(c.origin.branch) ?? []), c]);
  const rank = (b: string | null) => (b === null ? Number.MAX_SAFE_INTEGER : input.branchOrder.indexOf(b) === -1 ? input.branchOrder.length : input.branchOrder.indexOf(b));
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));

  const out: string[] = ["# Review feedback", ""];
  const spread = ordered.length > 1 ? ` on ${ordered.length} branches` : "";
  out.push(`Decision: **${DECISION_LABEL[input.decision]}** · ${comments.length} comment${comments.length === 1 ? "" : "s"}${spread}`);
  if (input.summary.trim()) out.push("", "## Summary", "", input.summary.trim());

  for (const [branch, list] of ordered) {
    const pr = branch ? input.prs.get(branch) : undefined;
    out.push("", branch ? `## Branch \`${branch}\`${pr ? ` (#${pr})` : ""}` : "## Detached HEAD");
    list.sort((a, b) => (a.anchor.path === b.anchor.path ? a.anchor.start - b.anchor.start : a.anchor.path < b.anchor.path ? -1 : 1));
    for (const c of list) {
      const { path, side, start, end } = c.anchor;
      const lines = start === end ? `${start}` : `${start}-${end}`;
      out.push("", `### \`${path}:${lines}\`${side === "old" ? " (removed lines, old numbering)" : ""}`);
      const where = c.origin.working ? "uncommitted changes" : `commit ${c.origin.head.slice(0, 10)}`;
      out.push(`Written against ${where}.${input.outdated.has(c.id) ? " This code has changed since; use the snippet to find the spot." : ""}`);
      if (c.snippet.length > 0) out.push("", "```" + languageHint(path), ...c.snippet, "```");
      out.push("", c.body.trim());
    }
  }
  if (comments.length === 0 && !input.summary.trim()) out.push("", "_No comments._");

  if (input.decision !== "approve" && comments.length > 0) {
    out.push("", "---", "");
    if (ordered.length > 1 || ordered[0]?.[0]) {
      out.push(
        input.usesSpice
          ? "Fix each comment on the branch it is listed under: `git-spice branch checkout <branch>`, commit there, then `git-spice upstack restack` so the branches above pick it up."
          : "Fix each comment on the branch it is listed under, then rebase the branches stacked above it.",
      );
    }
    out.push("When every comment is addressed, start `turndiff review` in the background again so the reviewer can re-check.");
  }
  return out.join("\n") + "\n";
}

const LANGUAGES: Record<string, string> = {
  py: "python",
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  json: "json",
  md: "md",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  go: "go",
  rs: "rust",
  rb: "ruby",
  tf: "hcl",
  sql: "sql",
  css: "css",
  html: "html",
  toml: "toml",
};

function languageHint(file: string): string {
  return LANGUAGES[file.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}
