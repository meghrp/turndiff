import { describe, expect, test } from "bun:test";
import { indexPatch } from "./patchLines.ts";

const patch = `diff --git a/feat_b.py b/feat_b.py
index b859599..290f5d8 100644
--- a/feat_b.py
+++ b/feat_b.py
@@ -1,2 +1,5 @@
 def f():
-    return 1
+    return 10
+
+def g():
+    return 2
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -5,2 +5,2 @@
 keep
-gone
+here
`;

describe("indexPatch", () => {
  const idx = indexPatch(patch);

  test("addition and deletion sides are tracked separately", () => {
    expect(idx.get("feat_b.py", "additions", 2)).toBe("    return 10");
    expect(idx.get("feat_b.py", "deletions", 2)).toBe("    return 1");
    expect(idx.get("feat_b.py", "additions", 4)).toBe("def g():");
  });

  test("context lines exist on both sides", () => {
    expect(idx.get("feat_b.py", "additions", 1)).toBe("def f():");
    expect(idx.get("feat_b.py", "deletions", 1)).toBe("def f():");
  });

  test("renamed file is keyed by its new path", () => {
    expect(idx.get("new.txt", "additions", 6)).toBe("here");
    expect(idx.get("new.txt", "deletions", 6)).toBe("gone");
    expect(idx.get("old.txt", "additions", 6)).toBeUndefined();
  });
});
