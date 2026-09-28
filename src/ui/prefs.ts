import { useCallback, useState } from "react";

const PREFIX = "turndiff:";

export function usePref<T>(key: string, initial: T): [T, (v: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((old: T) => T)) =>
      setValue((old) => {
        const next = typeof v === "function" ? (v as (old: T) => T)(old) : v;
        localStorage.setItem(PREFIX + key, JSON.stringify(next));
        return next;
      }),
    [key],
  );
  return [value, set];
}

/** Unsaved composer text, so nothing typed is lost to a closed composer or a reload. */
export const drafts = {
  get: (key: string) => localStorage.getItem(`${PREFIX}draft:${key}`),
  set: (key: string, body: string) =>
    body ? localStorage.setItem(`${PREFIX}draft:${key}`, body) : localStorage.removeItem(`${PREFIX}draft:${key}`),
  clear: (key: string) => localStorage.removeItem(`${PREFIX}draft:${key}`),
};
