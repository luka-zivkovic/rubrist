import { useId } from "react";
import { conversationEvidence, messageRole } from "../lib/trace-evidence.js";
import { isRecordedTrajectory, messageEvidence } from "../lib/message-evidence.js";

// Navigation only: these controls never record a label or infer a finding.
export function ReviewEvidenceNavigation({ input, metadata, structured, onSection, onMessage }: {
  input: unknown; metadata: unknown; structured: boolean;
  onSection: (section: "evidence" | "assessment" | "review") => void;
  onMessage: (index: number) => void;
}) {
  const selectId = useId();
  const projection = structured ? null : conversationEvidence(input);
  const imported = isRecordedTrajectory(input, metadata);
  return <nav aria-label="Case navigation" className="fixed inset-x-0 bottom-0 z-20 lg:left-[256px] border-t border-rule bg-paper px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-sm xl:hidden">
    <div className="mx-auto max-w-xl space-y-1">
      <div className="grid grid-cols-3 gap-2">
        {(["evidence", "assessment", "review"] as const).map(section => <button key={section} type="button"
          onClick={() => onSection(section)}
          className="min-h-11 rounded-sm border border-rule-soft bg-card text-[13px] font-medium capitalize hover:bg-card-2 focus-visible:outline-2 focus-visible:outline-offset-2">
          {section}
        </button>)}
      </div>
      {projection?.kind === "messages" ? <div className="flex items-center gap-3">
        <label htmlFor={selectId} className="shrink-0 text-[12px] font-medium">Jump to</label>
        <select id={selectId} aria-label="Jump to recorded message" value="" onChange={event => {
          if (event.target.value !== "") onMessage(Number(event.target.value));
        }} className="min-h-11 min-w-0 flex-1 rounded-sm border border-rule-soft bg-card px-2 text-[16px] focus-visible:outline-2 focus-visible:outline-offset-2">
          <option value="" disabled>Choose a message…</option>
          {projection.messages.map((value, index) => {
            const entry = messageEvidence(value, index, imported);
            return <option key={index} value={index}>{entry.sourceIndex !== null ? `Message ${entry.sourceIndex}` : `Entry ${index + 1}`} · {messageRole(entry.record?.role)}{entry.name ? ` · ${entry.name}` : ""}</option>;
          })}
        </select>
      </div> : null}
    </div>
  </nav>;
}
