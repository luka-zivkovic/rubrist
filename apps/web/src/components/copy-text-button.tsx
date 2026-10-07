import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { copyTextToClipboard } from "../lib/clipboard.js";

// One small copy affordance for recorded evidence. Copies the text it is
// given, exactly; it never reformats or trims.
export function CopyTextButton({ text, label = "Copy JSON" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  // A plain button, so evidence components stay free of the UI kit's alias imports.
  return <button type="button" aria-live="polite"
    className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm border border-rule-soft px-2 text-[11.5px] text-ink-2 hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&_svg]:size-3.5"
    onClick={() => void copyTextToClipboard(text).then(() => setState("copied"), () => setState("failed"))}>
    {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    {state === "copied" ? "Copied" : state === "failed" ? "Select and copy manually" : label}
  </button>;
}
