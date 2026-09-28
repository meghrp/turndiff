import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewState, Scope } from "../shared.ts";
import { backupReview, loadReview, saveReview } from "./store.ts";
import { emptyReview } from "./reviewState.ts";

export function useReview(repo: string, scope: Scope) {
  const [review, setReview] = useState<ReviewState>(emptyReview);
  const current = useRef(review);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading saved review…");
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const dirty = useRef(false);
  const stopped = useRef(false);
  const persist = useCallback(
    async (value: ReviewState) => {
      if (active.current) {
        setStatus("Saving…");
        setError(null);
      }
      try {
        await saveReview(scope, value);
        if (current.current.updatedAt === value.updatedAt) {
          dirty.current = false;
          if (active.current) setStatus("Saved to repository");
        }
      } catch (e) {
        if (active.current && current.current.updatedAt === value.updatedAt) {
          setError(`Draft could not be saved: ${(e as Error).message}`);
          setStatus("Not saved to repository");
        }
        throw e;
      }
    },
    [scope],
  );
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    loadReview(repo, scope)
      .then((value) => {
        if (cancelled) return;
        current.current = value;
        setReview(value);
        setReady(true);
        setStatus("Saved to repository");
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not load saved review: ${e.message}. Reload to retry.`);
      });
    const leave = () => {
      if (dirty.current && !stopped.current) void saveReview(scope, current.current, true).catch(() => {});
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current && !stopped.current) e.preventDefault();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", warn);
    return () => {
      cancelled = true;
      active.current = false;
      leave();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", warn);
    };
  }, [repo, scope]);
  const change = useCallback(
    (fn: (previous: ReviewState) => ReviewState) => {
      const value = { ...fn(current.current), updatedAt: Math.max(Date.now(), current.current.updatedAt + 1) };
      current.current = value;
      dirty.current = true;
      setReview(value);
      backupReview(repo, scope, value);
      void persist(value).catch(() => {});
    },
    [repo, scope, persist],
  );
  const flush = async () => {
    if (dirty.current) await persist(current.current);
  };
  const finish = () => {
    stopped.current = true;
    dirty.current = false;
    backupReview(repo, scope, { ...emptyReview(), updatedAt: 0 });
  };
  return { review, current, ready, status, error, change, flush, retry: () => persist(current.current), finish };
}
