import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoPaths } from "../git/exec.ts";
import { scopeKey, type ReviewState, type Scope } from "../shared.ts";

export function reviewFile(paths: RepoPaths, scope: Scope): string {
  const id = createHash("sha256")
    .update(`${paths.root}\0${scopeKey(scope)}`)
    .digest("hex");
  return join(paths.commonDir, "turndiff", "drafts", `${id}.json`);
}

export async function readReview(paths: RepoPaths, scope: Scope): Promise<ReviewState | null> {
  try {
    return JSON.parse(await readFile(reviewFile(paths, scope), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// Serialize each file's writes and rename atomically. Older requests must never
// overwrite newer text, including a final keepalive save as the tab closes.
const queues = new Map<string, Promise<unknown>>();
export async function writeReview(paths: RepoPaths, scope: Scope, state: ReviewState): Promise<void> {
  const file = reviewFile(paths, scope);
  const operation = (queues.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const previous = await readReview(paths, scope);
      if (previous && previous.updatedAt > state.updatedAt) return;
      await mkdir(join(paths.commonDir, "turndiff", "drafts"), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state));
      await rename(temp, file);
    });
  queues.set(file, operation);
  try {
    await operation;
  } finally {
    if (queues.get(file) === operation) queues.delete(file);
  }
}
