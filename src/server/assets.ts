// The UI is bundled once into dist/ui with Bun.build and served as static
// files. Bundling at request time would be slower on every launch and Bun's
// HTML routes resolve asset URLs against process.cwd(), which is the repo
// under review, not this package.

import { existsSync, statSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const UI_SRC = join(PKG_ROOT, "src", "ui");
const OUT_DIR = join(PKG_ROOT, "dist", "ui");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

function isStale(): boolean {
  const indexOut = join(OUT_DIR, "index.html");
  if (!existsSync(indexOut)) return true;
  const built = statSync(indexOut).mtimeMs;
  return newestMtime(join(PKG_ROOT, "src")) > built;
}

export async function ensureUiBuilt(opts: { force?: boolean; log?: (msg: string) => void } = {}): Promise<string> {
  if (!opts.force && !isStale()) return OUT_DIR;
  opts.log?.("building UI…");
  await rm(OUT_DIR, { recursive: true, force: true });
  // Bundle the script entry only. Bun's HTML entrypoints mis-link the script
  // tag when code splitting is on, so the HTML shell is written by hand below.
  const result = await Bun.build({
    entrypoints: [join(UI_SRC, "main.tsx")],
    outdir: OUT_DIR,
    target: "browser",
    minify: true,
    sourcemap: "none",
    splitting: true,
    naming: { chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]", entry: "[name]-[hash].[ext]" },
  });
  if (!result.success) {
    const msgs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`UI build failed:\n${msgs}`);
  }
  const entry = result.outputs.find((o) => o.kind === "entry-point");
  if (!entry) throw new Error("UI build produced no entry point");
  const entryHref = "/" + relative(OUT_DIR, entry.path);
  const css = await Bun.file(join(UI_SRC, "styles.css")).text();
  const cssName = `styles-${Bun.hash(css).toString(36)}.css`;
  await Bun.write(join(OUT_DIR, cssName), css);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>turndiff</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23e6b450'/%3E%3C/svg%3E" />
<link rel="stylesheet" href="/${cssName}" />
</head>
<body>
<div id="root"></div>
<script type="module" src="${entryHref}"></script>
</body>
</html>
`;
  await Bun.write(join(OUT_DIR, "index.html"), html);
  return OUT_DIR;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function serveAsset(outDir: string, pathname: string): Response | null {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return null;
  const file = join(outDir, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) return null;
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const immutable = rel !== "/index.html";
  return new Response(Bun.file(file), {
    headers: { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
  });
}
