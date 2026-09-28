import { useId, useState, type ReactNode } from "react";

/** Inline-safe disclosure for occasional identifiers, including inside tables. */
export function InlineDetails({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <span onClick={(event) => event.stopPropagation()} className="inline-flex max-w-full flex-wrap items-center gap-1.5 text-[10.5px] text-ink-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        className="cursor-pointer rounded-sm px-1 py-0.5 text-left hover:bg-paper-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"} </span>{label}
      </button>
      <span id={contentId} hidden={!open} className="min-w-0 break-all font-mono">{children}</span>
    </span>
  );
}
