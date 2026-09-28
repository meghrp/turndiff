import { useState } from "react";
import type { FileStat } from "../../git/diff.ts";
export function FileList({
  files,
  active,
  viewed,
  commentCounts,
  onJump,
  onToggleViewed,
}: {
  files: FileStat[];
  active: string | null;
  viewed: Set<string>;
  commentCounts: Map<string, number>;
  onJump: (p: string) => void;
  onToggleViewed: (p: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [unviewed, setUnviewed] = useState(false);
  const visible = files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()) && (!unviewed || !viewed.has(f.path)));
  const remaining = files.filter((f) => !viewed.has(f.path));
  const next = () => {
    const index = files.findIndex((f) => f.path === active);
    const ordered = [...files.slice(index + 1), ...files.slice(0, index + 1)];
    const target = ordered.find((f) => !viewed.has(f.path));
    if (target) onJump(target.path);
  };
  return (
    <nav className="filelist" aria-label="Changed files">
      <div className="section">
        <h3>
          Files <span className="sub">{files.length}</span>
        </h3>
        <div className="summary">
          <span>
            {files.length - remaining.length}/{files.length} viewed
          </span>
          <span className="stat">
            <span className="add">+{files.reduce((n, f) => n + f.additions, 0)}</span>{" "}
            <span className="del">−{files.reduce((n, f) => n + f.deletions, 0)}</span>
          </span>
        </div>
        <div className="file-tools">
          <input
            type="search"
            aria-label="Search files"
            placeholder="Search files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label>
            <input type="checkbox" checked={unviewed} onChange={(e) => setUnviewed(e.target.checked)} />
            Unviewed only
          </label>
          <button className="btn" disabled={!remaining.length} onClick={next}>
            Next unviewed
          </button>
        </div>
        {visible.map((f) => (
          <div key={f.path} className={`file ${active === f.path ? "on" : ""} ${viewed.has(f.path) ? "viewed" : ""}`}>
            <input
              type="checkbox"
              checked={viewed.has(f.path)}
              onChange={() => onToggleViewed(f.path)}
              aria-label={`Mark ${f.path} viewed`}
            />
            <button
              className="file-jump"
              aria-current={active === f.path ? "location" : undefined}
              onClick={() => onJump(f.path)}
              title={f.path}
            >
              <span className="path">
                <span>{f.path}</span>
              </span>
              <span className="stat">
                {(commentCounts.get(f.path) ?? 0) > 0 && (
                  <span className="badge cmt" aria-label={`${commentCounts.get(f.path)} comments`}>
                    {commentCounts.get(f.path)}
                  </span>
                )}{" "}
                {f.binary ? (
                  "bin"
                ) : (
                  <>
                    <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                  </>
                )}
              </span>
            </button>
          </div>
        ))}
        {!visible.length && <p className="empty">{files.length ? "No files match these filters." : "No changed files."}</p>}
      </div>
    </nav>
  );
}
