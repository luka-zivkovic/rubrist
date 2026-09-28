import {
  defaultEvaluatorOutputSchema,
  verdictOutputSchema,
  type CreateSkillVersionInput,
  type SkillVersion,
  type RubricProvenance,
  type SkillVersionTimeScope
} from "@rubrist/shared";
import { executionBindingInputFromFields, type ExecutionBindingFields } from "./execution-binding-draft.js";
import { shouldRegenerateVerdictOutputSchema } from "./skill-edit-flow.js";
import { typedQuestionFromDraft, type TypedQuestionDraft } from "./typed-question-draft.js";

// The create-version request the evaluator editor sends (Batch 8F). The
// provider decides the definition kind: TypeSafe runs a typed question, and
// every other provider a prompted review guide and judge instructions
// (ADR-0014 section 5).

export interface EditorVersionDraft {
  /** The version the editor started from; settings the editor leaves out carry over from it. */
  base: SkillVersion;
  criterionVersionId: string | null;
  rubricProvenance?: RubricProvenance;
  binding: ExecutionBindingFields;
  rubricMarkdown: string;
  prompt: string;
  typedQuestion: TypedQuestionDraft;
  verdict: Pick<SkillVersion, "verdictKind" | "scalarRange" | "categoricalChoiceScores">;
  timeScope: SkillVersionTimeScope;
  firstRun: boolean;
  /** A starter template supplied the result contract. */
  starterSuppliedContract: boolean;
  overrideReason?: string | undefined;
}

/** The request the editor saves, or `null` while a field is incomplete or invalid. */
export function skillVersionInputFromDraft(draft: EditorVersionDraft): CreateSkillVersionInput | null {
  const executionBinding = executionBindingInputFromFields(draft.binding, draft.base.executionBinding);
  if (executionBinding === null) return null;
  const common = {
    ...(draft.criterionVersionId ? { criterionVersionId: draft.criterionVersionId } : {}),
    executionBinding,
    ...(draft.rubricProvenance && draft.rubricProvenance !== "unspecified" ? { rubricProvenance: draft.rubricProvenance } : {}),
    timeScope: draft.timeScope,
    ...(draft.overrideReason ? { overrideReason: draft.overrideReason } : {})
  };
  if (executionBinding.provider === "typesafe") {
    // A typed question's verdict is binary, under its protocol's one fixed output contract.
    const definition = typedQuestionFromDraft(draft.typedQuestion);
    if (definition === null) return null;
    return {
      ...common,
      ...definition,
      outputSchema: defaultEvaluatorOutputSchema(executionBinding.verdictProtocol),
      verdictKind: "binary"
    };
  }
  const { verdictKind, scalarRange, categoricalChoiceScores } = draft.verdict;
  // A typed base's contract is its protocol's probability schema, which a
  // prompted version never keeps.
  const regenerateOutputSchema = draft.base.typedQuestion !== null || shouldRegenerateVerdictOutputSchema({
    firstRun: draft.firstRun,
    starterSuppliedContract: draft.starterSuppliedContract,
    base: draft.base,
    current: draft.verdict
  });
  return {
    ...common,
    rubricMarkdown: draft.rubricMarkdown,
    prompt: draft.prompt,
    outputSchema: regenerateOutputSchema
      ? verdictOutputSchema({ verdictKind, scalarRange, categoricalChoiceScores })
      : draft.base.outputSchema,
    verdictKind,
    ...(verdictKind === "scalar" && scalarRange ? { scalarRange } : {}),
    ...(verdictKind === "categorical" && categoricalChoiceScores ? { categoricalChoiceScores } : {})
  };
}
