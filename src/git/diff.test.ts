import { describe, expect, test } from "bun:test";
import { parseNumstat } from "./diff.ts";

describe("parseNumstat", () => {
  test("plain, binary and renamed entries", () => {
    const raw = ["3\t1\ta.txt", "-\t-\timg.png", "2\t0\t", "old/name.py", "new/name.py", ""].join("\0");
    expect(parseNumstat(raw)).toEqual([
      { path: "a.txt", oldPath: null, additions: 3, deletions: 1, binary: false },
      { path: "img.png", oldPath: null, additions: 0, deletions: 0, binary: true },
      { path: "new/name.py", oldPath: "old/name.py", additions: 2, deletions: 0, binary: false },
    ]);
  });

  test("empty output", () => {
    expect(parseNumstat("")).toEqual([]);
  });
});
