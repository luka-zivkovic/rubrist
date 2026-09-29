import { hasTruncationMarker } from "../lib/trace-evidence.js";

export function EvidenceTruncationWarning({ input, output, steps }: {
  input: unknown; output: unknown; steps?: unknown;
}) {
  if (!hasTruncationMarker({ input, output, steps })) return null;
  return <aside className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-[12px] leading-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
    <p className="font-semibold">Truncation marker in recorded evidence</p>
    <p>Some context may be missing. Missing content is not evidence of failure; check the source before relying on this assessment.</p>
  </aside>;
}
