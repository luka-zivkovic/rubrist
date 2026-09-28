import { RubricProvenanceSchema, type RubricProvenance } from "@rubrist/shared";

export function EvaluatorAuthorshipField({ value, onChange, disabled = false }: {
  value: RubricProvenance;
  onChange: (value: RubricProvenance) => void;
  disabled?: boolean;
}) {
  return (
    <details className="mb-4 rounded-sm border border-rule-soft px-3 py-2">
      <summary className="cursor-pointer text-[12px] text-ink-2">
        Authorship · {value === "unspecified" ? "not specified (optional)" : value === "human-authored" ? "human-authored" : "agent-drafted or assisted"}
      </summary>
      <label className="mt-3 flex flex-col gap-2 text-[12px] text-ink-2">
        Who drafted this version?
        <select aria-label="Who drafted this version?" value={value} disabled={disabled}
          onChange={(event) => onChange(RubricProvenanceSchema.parse(event.target.value))}
          className="h-9 rounded-sm border border-rule-soft bg-card px-2 text-ink">
          <option value="unspecified">Not specified</option>
          <option value="human-authored">Human-authored</option>
          <option value="agent-drafted">Agent-drafted or assisted</option>
        </select>
      </label>
      <p className="mt-2 text-[11.5px] leading-5 text-ink-3">
        Describe the whole version, including any reused or generated instructions. Saving from your
        account does not establish authorship. This declaration does not approve or validate the evaluator.
      </p>
    </details>
  );
}
