// Index a unified patch so a (file, side, line) triple can be turned back into
// its text. Used to attach snippets to comments for the agent.

export interface PatchIndex {
  get(file: string, side: "additions" | "deletions", line: number): string | undefined;
}

export function indexPatch(patch: string): PatchIndex {
  const files = new Map<string, { add: Map<number, string>; del: Map<number, string> }>();
  let cur: { add: Map<number, string>; del: Map<number, string> } | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = { add: new Map(), del: new Map() };
      // Path comes from the +++ header; provisional key from the diff line.
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      if (m) files.set(m[2]!, cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") files.set(p.startsWith("b/") ? p.slice(2) : p, cur);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("similarity ") || raw.startsWith("rename ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("Binary files")) continue;
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const c = raw[0];
    const text = raw.slice(1);
    if (c === "+") cur.add.set(newLine++, text);
    else if (c === "-") cur.del.set(oldLine++, text);
    else if (c === " " || raw.length === 0) {
      cur.add.set(newLine, text);
      cur.del.set(oldLine, text);
      newLine++;
      oldLine++;
    }
  }
  return {
    get(file, side, line) {
      const f = files.get(file);
      if (!f) return undefined;
      return side === "additions" ? f.add.get(line) : f.del.get(line);
    },
  };
}
