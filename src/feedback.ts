// Render a submission as markdown for the agent. Anchors use file:line so the
// agent can jump straight to the spot; the snippet gives it the exact code the
// comment refers to even if the file has moved on.

import type { Submission } from "./shared.ts";

const DECISION_LABEL: Record<Submission["decision"], string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  comment: "Comments only",
};

export function formatFeedback(sub: Submission): string {
  const out: string[] = [];
  out.push(`# Review feedback: ${sub.label}`);
  out.push("");
  out.push(`Decision: **${DECISION_LABEL[sub.decision]}**`);
  out.push(`Diff: \`${sub.baseOid.slice(0, 10)}..${sub.headOid.slice(0, 10)}\``);
  if (sub.summary.trim()) {
    out.push("");
    out.push("## Summary");
    out.push("");
    out.push(sub.summary.trim());
  }
  if (sub.comments.length > 0) {
    out.push("");
    out.push(`## Comments (${sub.comments.length})`);
    const byFile = new Map<string, Submission["comments"]>();
    for (const c of sub.comments) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
    for (const [file, comments] of byFile) {
      comments.sort((a, b) => a.lineStart - b.lineStart);
      for (const c of comments) {
        const range = c.lineStart === c.lineEnd ? `${c.lineStart}` : `${c.lineStart}-${c.lineEnd}`;
        const sideNote = c.side === "deletions" ? " (removed lines)" : "";
        out.push("");
        out.push(`### ${file}:${range}${sideNote}`);
        if (c.outdated)
          out.push(
            `Original context (code has since changed${c.revision ? `; reviewed revision ${c.revision}` : ""}). Line numbers below refer to that context.`,
          );
        if (c.snippet.length > 0) {
          out.push("");
          out.push("```" + languageHint(file));
          out.push(...c.snippet);
          out.push("```");
        }
        out.push("");
        out.push(c.body.trim());
      }
    }
  }
  if (sub.comments.length === 0 && !sub.summary.trim()) {
    out.push("");
    out.push("_No comments._");
  }
  out.push("");
  if (sub.decision === "request_changes") {
    out.push("Address every comment above, then run `turndiff review` again so the reviewer can re-check.");
  }
  return out.join("\n");
}

function languageHint(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
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
  return map[ext] ?? "";
}
