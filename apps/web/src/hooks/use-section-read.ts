import { useCallback, useEffect, useRef, useState } from "react";
import { loadFailure, type LoadFailure } from "@/lib/load-error";

// One section's read on a page that keeps working when a section fails.
//   idle    — nothing to read yet: the key is null
//   loading — the first read for this key is in flight
//   loaded  — the read succeeded
//   failed  — the read failed. `retrying` is true while a retry is in flight,
//             so the section keeps its error in place instead of blanking.
export type SectionRead<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: T }
  | { status: "failed"; failure: LoadFailure; retrying: boolean };

// Reads once per key; `retry` reads that key again. A new key starts over,
// and a read for an older key never lands on the new one. Pass a null key or
// read until the page knows what to read; the section is idle meanwhile, and
// forgets its last read so a later read of the same key starts fresh.
export function useSectionRead<T>(
  key: string | null,
  read: (() => Promise<T>) | null
): SectionRead<T> & { retry: () => void } {
  const [state, setState] = useState<{ key: string; read: SectionRead<T> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  useEffect(() => {
    const readForKey = readRef.current;
    if (key === null || readForKey === null) {
      setState(null);
      return;
    }
    let cancelled = false;
    setState((previous) =>
      previous?.key === key && previous.read.status === "failed"
        ? { key, read: { ...previous.read, retrying: true } }
        : { key, read: { status: "loading" } }
    );
    readForKey().then(
      (data) => {
        if (!cancelled) setState({ key, read: { status: "loaded", data } });
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, read: { status: "failed", failure: loadFailure(error), retrying: false } });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const current: SectionRead<T> =
    key === null || read === null ? { status: "idle" } : state?.key === key ? state.read : { status: "loading" };
  return { ...current, retry };
}
