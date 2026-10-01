import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitRaw, type RepoPaths } from "./exec.ts";
import { snapshotWorktree } from "./diff.ts";
import { loadStack, repoVersion } from "./stack.ts";
import { resolveView, TargetError } from "./views.ts";
import type { Annotation, FileChange, Guide, GuideFile, GuideSection, Oid, Side } from "../model.ts";

export type GuideCheck = { ok: true; guide: Guide; changedFiles: number; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Parse `raw` (the agent's JSON) and check it against the diff the branch view
 * shows for `branchName`, with uncommitted changes when it is checked out here.
 * Every problem is reported at once so the agent can fix them in one pass.
 */
export async function checkGuide(paths: RepoPaths, branchName: string, raw: unknown, now = new Date()): Promise<GuideCheck> {
  const errors: string[] = [];
  const input = parseInput(raw, errors);
  const { version, status } = await repoVersion(paths);
  const stack = await loadStack(paths, status);
  const branch = stack.branches.find((b) => b.name === branchName);
  if (!branch) return { ok: false, errors: [`${branchName} is not a branch of this stack`] };
  if (branch.parent === null) return { ok: false, errors: [`${branchName} is the trunk, which has no parent to diff against; pass --branch with a stack branch`] };
  let files: FileChange[];
  try {
    const view = await resolveView(
      { paths, stack, version, worktree: () => snapshotWorktree(paths), lastReview: null, ignoreWhitespace: false },
      { kind: "branch", branch: branchName, working: true },
    );
    files = view.sections[0]!.files;
  } catch (e) {
    if (e instanceof TargetError) return { ok: false, errors: [e.message, ...errors] };
    throw e;
  }

  const byPath = new Map(files.map((f) => [f.path, f]));
  const renamedFrom = new Map(files.flatMap((f) => (f.oldPath ? [[f.oldPath, f.path] as const] : [])));
  const notChanged = (where: string, path: string) => {
    const to = renamedFrom.get(path);
    return `${where}: ${path} is not changed on ${branchName}${to ? ` (it was renamed to ${to}; use the new path)` : ""}`;
  };

  const placedIn = new Map<string, { index: number; title: string }>();
  const sections = input.sections.map((s) => ({
    ...s,
    files: s.files.filter((f) => {
      const where = `sections[${s.index}].files[${f.index}]`;
      if (!byPath.has(f.path)) return errors.push(notChanged(where, f.path)), false;
      const first = placedIn.get(f.path);
      if (first) return errors.push(`${where}: ${f.path} is already placed in sections[${first.index}] ("${first.title}")`), false;
      placedIn.set(f.path, s);
      return true;
    }),
  }));

  // Blobs come from the diff itself, so a note matches exactly what the branch view shows (symlinks included).
  const annotations = input.annotations.flatMap((a) => {
    const where = `annotations[${a.index}]`;
    // The help asks for new paths; for the old side of a rename, agents also try the old path.
    const file = byPath.get(a.path) ?? (a.side === "old" ? files.find((f) => f.oldPath === a.path) : undefined);
    if (!file) return errors.push(notChanged(where, a.path)), [];
    if (file.binary) return errors.push(`${where}: ${a.path} is binary`), [];
    const blob = a.side === "new" ? file.newBlob : file.oldBlob;
    if (blob === null) {
      return errors.push(`${where}: ${a.path} has no ${a.side} side on ${branchName} (it is ${file.status}); use side "${a.side === "new" ? "old" : "new"}"`), [];
    }
    return [{ ...a, anchorPath: a.side === "new" ? file.path : (file.oldPath ?? file.path), blob }];
  });

  const lineCounts = await countLines(paths, annotations.map((a) => a.blob));
  for (const a of annotations) {
    const n = lineCounts.get(a.blob)!;
    if (a.lines[1] > n) errors.push(`annotations[${a.index}]: lines ${a.lines[0]}-${a.lines[1]} are outside ${a.path}, which has ${n} line${n === 1 ? "" : "s"} on the ${a.side} side`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const unplaced = files.filter((f) => !placedIn.has(f.path)).map((f) => f.path);
  const warnings =
    unplaced.length === 0
      ? []
      : [`${unplaced.length} changed file${unplaced.length === 1 ? " is" : "s are"} in no section and will be listed under "Everything else": ${list(unplaced)}`];
  const guide: Guide = {
    branch: branchName,
    author: input.author,
    writtenAt: now.toISOString(),
    head: branch.tip,
    intent: input.intent,
    sections: sections.map(
      (s): GuideSection => ({
        title: s.title,
        overview: s.overview,
        files: s.files.map((f): GuideFile => ({ path: f.path, summary: f.summary, blob: byPath.get(f.path)!.newBlob })),
      }),
    ),
    annotations: annotations.map(
      (a): Annotation => ({
        id: crypto.randomUUID(),
        anchor: { path: a.anchorPath, side: a.side, start: a.lines[0], end: a.lines[1], blob: a.blob },
        summary: a.summary,
        rationale: a.rationale,
      }),
    ),
  };
  return { ok: true, guide, changedFiles: files.length, warnings };
}

const list = (paths: string[]) => (paths.length <= 10 ? paths.join(", ") : `${paths.slice(0, 10).join(", ")} and ${paths.length - 10} more`);

/** GuideInput after parsing. `index` is the item's position in the agent's JSON, for error messages. */
interface ParsedInput {
  author: string | null;
  intent: string;
  sections: { index: number; title: string; overview: string; files: { index: number; path: string; summary: string }[] }[];
  annotations: { index: number; path: string; side: Side; lines: [number, number]; summary: string; rationale: string | null }[];
}

const KNOWN = {
  root: ["author", "intent", "sections", "annotations"],
  section: ["title", "overview", "files"],
  file: ["path", "summary"],
  annotation: ["path", "side", "lines", "summary", "rationale"],
};

/** Collects every shape error into `errors` and returns what parsed, so the diff checks can still run on the valid parts. */
function parseInput(raw: unknown, errors: string[]): ParsedInput {
  const out: ParsedInput = { author: null, intent: "", sections: [], annotations: [] };
  if (!isObject(raw)) {
    errors.push("the guide must be a JSON object (see `turndiff guide --help`)");
    return out;
  }
  const unknown = (obj: Record<string, unknown>, known: string[], where: string) => {
    for (const k of Object.keys(obj)) if (!known.includes(k)) errors.push(`${where}${where ? "." : ""}${k}: unknown field (expected ${known.join(", ")})`);
  };
  const text = (obj: Record<string, unknown>, key: string, where: string, opts: { optional?: boolean } = {}): string | null => {
    const v = obj[key];
    if (v === undefined && opts.optional) return null;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`${where}${where ? "." : ""}${key}: expected a non-empty string`);
      return null;
    }
    return v.trim();
  };
  unknown(raw, KNOWN.root, "");
  out.author = text(raw, "author", "", { optional: true });
  out.intent = text(raw, "intent", "") ?? "";

  if (!Array.isArray(raw.sections) || raw.sections.length === 0) errors.push("sections: expected a non-empty array");
  else
    raw.sections.forEach((s: unknown, i) => {
      const where = `sections[${i}]`;
      if (!isObject(s)) return errors.push(`${where}: expected an object with title, overview and files`);
      unknown(s, KNOWN.section, where);
      const title = text(s, "title", where);
      const overview = text(s, "overview", where);
      const files: ParsedInput["sections"][number]["files"] = [];
      if (!Array.isArray(s.files) || s.files.length === 0) errors.push(`${where}.files: expected a non-empty array`);
      else
        s.files.forEach((f: unknown, j) => {
          const fw = `${where}.files[${j}]`;
          if (!isObject(f)) return errors.push(`${fw}: expected an object with path and summary`);
          unknown(f, KNOWN.file, fw);
          const path = text(f, "path", fw);
          const summary = text(f, "summary", fw);
          if (path !== null && summary !== null) files.push({ index: j, path, summary });
        });
      if (title !== null && overview !== null) out.sections.push({ index: i, title, overview, files });
    });

  if (raw.annotations !== undefined && !Array.isArray(raw.annotations)) errors.push("annotations: expected an array");
  else
    (raw.annotations ?? []).forEach((a: unknown, i: number) => {
      const where = `annotations[${i}]`;
      if (!isObject(a)) return errors.push(`${where}: expected an object with path, lines and summary`);
      unknown(a, KNOWN.annotation, where);
      const path = text(a, "path", where);
      const summary = text(a, "summary", where);
      const rationale = text(a, "rationale", where, { optional: true });
      const side = a.side ?? "new";
      if (side !== "new" && side !== "old") errors.push(`${where}.side: expected "new" or "old"`);
      const l = a.lines;
      const lines = Array.isArray(l) && l.length === 2 && l.every((n) => Number.isInteger(n)) ? (l as [number, number]) : null;
      if (!lines || lines[0] < 1 || lines[1] < lines[0]) errors.push(`${where}.lines: expected [start, end], 1-based with start <= end`);
      if (path !== null && summary !== null && lines && lines[0] >= 1 && lines[1] >= lines[0] && (side === "new" || side === "old")) {
        out.annotations.push({ index: i, path, side, lines, summary, rationale });
      }
    });
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lines in each blob. The diff's blobs are in the object store, worktree ones included (snapshotWorktree writes them). */
async function countLines(paths: RepoPaths, blobs: Oid[]): Promise<Map<Oid, number>> {
  const out = new Map<Oid, number>();
  for (const oid of new Set(blobs)) {
    const text = (await gitRaw(paths.root, ["cat-file", "blob", oid])).stdout;
    out.set(oid, text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
  }
  return out;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const guidesDir = (paths: RepoPaths) => join(paths.commonDir, "turndiff", "guides");
const guideFile = (paths: RepoPaths, branch: string) => join(guidesDir(paths), `${encodeURIComponent(branch)}.json`);

/** Store `guide` as its branch's guide, replacing any earlier one. */
export async function writeGuide(paths: RepoPaths, guide: Guide): Promise<void> {
  const file = guideFile(paths, guide.branch);
  await mkdir(guidesDir(paths), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(guide, null, 2) + "\n");
  await rename(tmp, file);
}

export async function readGuides(paths: RepoPaths): Promise<Guide[]> {
  let names: string[];
  try {
    names = readdirSync(guidesDir(paths)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const guides = await Promise.all(
    names.map(async (n) => {
      try {
        return JSON.parse(await readFile(join(guidesDir(paths), n), "utf8")) as Guide;
      } catch {
        return null;
      }
    }),
  );
  return guides.filter((g): g is Guide => g !== null).sort((a, b) => a.branch.localeCompare(b.branch));
}

/** False when the branch had no guide. */
export async function removeGuide(paths: RepoPaths, branch: string): Promise<boolean> {
  const file = guideFile(paths, branch);
  if (!isFile(file)) return false;
  await rm(file);
  return true;
}

/** Changes whenever a guide is written or removed. Polled with /api/state, so it only stats the guides directory. */
export function guidesVersion(paths: RepoPaths): string {
  const dir = guidesDir(paths);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return "";
  }
  if (names.length === 0) return "";
  const hash = createHash("sha1");
  for (const n of names) {
    try {
      const st = statSync(join(dir, n));
      hash.update(`${n}\0${st.mtimeMs}\0${st.size}\n`);
    } catch {
      /* removed while listing */
    }
  }
  return hash.digest("hex").slice(0, 16);
}
