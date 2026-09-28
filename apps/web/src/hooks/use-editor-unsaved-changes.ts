import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/** Compare raw draft fields, including invalid input, with the form as opened. */
export function useEditorUnsavedChanges(snapshot: string, enabled: boolean) {
  const opened = useRef<string | null>(null);
  if (!enabled) opened.current = null;
  else if (opened.current === null) opened.current = snapshot;
  const current = useRef(snapshot);
  current.current = snapshot;
  const active = useRef(enabled);
  active.current = enabled;
  // Resetting after a recorded result prepares a clean form for the next
  // render; URL bookkeeping in the same event must not look like an edit.
  const dirty = () => active.current && opened.current !== null && opened.current !== current.current;
  const confirmDiscard = () => !dirty() || window.confirm("Discard your unsaved evaluator changes?");

  // Read the refs at navigation time: a successful save marks the draft clean
  // before updating the URL to the newly recorded version.
  useBlocker(() => !confirmDiscard());
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  return {
    confirmDiscard,
    markClean: () => { opened.current = current.current; },
    resetBaseline: () => { opened.current = null; }
  };
}
