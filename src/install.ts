import { lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shellArg = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export async function install(opts: { homeDir: string; repoDir: string; bunPath: string; skillOnly: boolean }): Promise<string[]> {
  const { homeDir, repoDir, bunPath, skillOnly } = opts;
  const settingsPath = join(homeDir, ".claude", "settings.json");
  let previous: string | null = null;
  try {
    if (!skillOnly) previous = await readFile(settingsPath, "utf8");
  } catch (e) {
    if (!object(e) || e.code !== "ENOENT") throw e;
  }
  const raw: unknown = previous === null ? {} : JSON.parse(previous);
  if (!object(raw)) throw new Error(`${settingsPath} must contain a JSON object`);
  const settings = raw;
  const hooks = settings.hooks ?? {};
  if (!object(hooks)) throw new Error(`${settingsPath}: hooks must be an object`);
  const command = `${shellArg(bunPath)} ${shellArg(join(repoDir, "src", "cli.ts"))} hook`;
  const legacyCommand = `${bunPath} ${join(repoDir, "src", "cli.ts")} hook`;
  let changed = false;
  if (!skillOnly) {
    for (const event of ["UserPromptSubmit", "Stop"]) {
      const list = hooks[event] ?? [];
      if (!Array.isArray(list)) throw new Error(`${settingsPath}: hooks.${event} must be an array`);
      let found = false;
      for (const group of list) {
        if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`${settingsPath}: hooks.${event} has a malformed hook group`);
        for (const hook of group.hooks) {
          if (!object(hook)) throw new Error(`${settingsPath}: hooks.${event} has a malformed hook`);
          if (hook.type === "command" && (hook.command === command || hook.command === legacyCommand)) {
            found = true;
            if (hook.command !== command) {
              hook.command = command;
              changed = true;
            }
          }
        }
      }
      if (!found) {
        list.push({ hooks: [{ type: "command", command, timeout: 60 }] });
        hooks[event] = list;
        changed = true;
      }
    }
  }
  const skillsDir = join(homeDir, ".claude", "skills");
  const skillLink = join(skillsDir, "turndiff-review");
  const target = join(repoDir, "skills", "turndiff-review");
  let existing = null;
  try {
    existing = await lstat(skillLink);
  } catch (e) {
    if (!object(e) || e.code !== "ENOENT") throw e;
  }
  if (existing && !existing.isSymbolicLink())
    throw new Error(`${skillLink} already exists and is not a symlink; move it before installing`);
  await mkdir(skillsDir, { recursive: true });
  if (!existing || (await readlink(skillLink)) !== target) {
    if (existing) await unlink(skillLink);
    await symlink(target, skillLink);
  }
  const messages = [`skill: ${skillLink} -> ${target}`];
  if (!skillOnly) {
    if (changed) {
      settings.hooks = hooks;
      const tmp = `${settingsPath}.${crypto.randomUUID()}.tmp`;
      if (previous !== null) {
        await writeFile(`${tmp}.bak`, previous, { mode: 0o600 });
        await rename(`${tmp}.bak`, `${settingsPath}.turndiff.bak`);
      }
      await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, settingsPath);
      messages.push(`hooks: added UserPromptSubmit + Stop to ${settingsPath}`);
    } else messages.push(`hooks: already present in ${settingsPath}`);
  }
  return messages;
}
