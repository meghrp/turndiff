import { expect, spyOn, test } from "bun:test";
import { api } from "./api.ts";

const browser: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } = globalThis;

test("copying and submitting wait for an earlier summary save", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let summary = "";
  const calls: string[] = [];
  const fetch = spyOn(browser, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/summary") {
      started();
      await gate;
      summary = JSON.parse(String(init?.body)).summary;
      return Response.json({ comments: [], summary, viewed: [], outdated: [] });
    }
    if (path.startsWith("/api/feedback")) return Response.json({ markdown: summary });
    const markdown = summary;
    summary = "";
    return Response.json({ markdown, delivered: false });
  });
  try {
    const saving = api.setSummary("saved before submit");
    await requested;
    const copying = api.feedback("comment");
    const submitting = api.submit("approve", "saved before submit");
    await Promise.resolve();
    expect(calls).toEqual(["/api/summary"]);
    release();
    await saving;
    expect((await copying).markdown).toBe("saved before submit");
    expect((await submitting).markdown).toBe("saved before submit");
    expect(summary).toBe("");
    expect(calls).toEqual(["/api/summary", "/api/feedback?decision=comment", "/api/submit"]);
  } finally {
    release();
    fetch.mockRestore();
  }
});

test("a failed autosave does not prevent a later submission with the current summary", async () => {
  const fetch = spyOn(browser, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === "/api/summary") throw new Error("connection lost");
    return Response.json({ markdown: JSON.parse(String(init?.body)).summary, delivered: false });
  });
  try {
    await expect(api.setSummary("failed autosave")).rejects.toThrow("connection lost");
    expect((await api.submit("comment", "current draft")).markdown).toBe("current draft");
  } finally {
    fetch.mockRestore();
  }
});
