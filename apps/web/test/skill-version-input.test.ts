import { describe, expect, it } from "vitest";
import {
  CreateSkillVersionInputSchema,
  MinimumVerdictOutputSchema,
  SEEDED_DEFAULT_EXECUTION_BINDING,
  TypedQuestionOutputSchema,
  evaluatorDefinitionInputIssues,
  isTypedQuestionOutputSchema,
  verdictOutputSchema,
  type SkillVersion
} from "@rubrist/shared";
import { skillVersionInputFromDraft, type EditorVersionDraft } from "../src/lib/skill-version-input.js";
import { EMPTY_TYPED_QUESTION_DRAFT } from "../src/lib/typed-question-draft.js";

// The request the evaluator editor saves (Batch 8F): the provider decides the
// definition kind, and each kind sends only its own definition and contract.

const QUESTION = { type: "noul" as const, instructions: "Is the reply grounded?", criteria: { true: "Grounded.", false: "Not grounded." } };
const JEV = {
  provider: "typesafe" as const, endpoint: { kind: "managed" as const }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
  sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "typed-question/v1" as const, routing: null
};

const prompted: SkillVersion = {
  id: "v1", skillId: "skill", criterionVersionId: "cv", version: "1.0.0", status: "approved",
  rubricMarkdown: "# Guide", prompt: "Judge against {{rubric_markdown}}.", typedQuestion: null, decisionThreshold: null,
  executionBinding: structuredClone(SEEDED_DEFAULT_EXECUTION_BINDING), customEndpointUrl: null,
  outputSchema: MinimumVerdictOutputSchema, goldenSetAgreement: null, tooStrictCount: 0, tooLenientCount: 0, ambiguousCount: 0,
  knownLimitations: [], verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null, rubricProvenance: "human-authored",
  regressionDatasetRevisionId: "rev", createdAt: "2026-09-27T00:00:00.000Z", approvedAt: null
};
const typed: SkillVersion = {
  ...prompted, id: "v2", version: "1.1.0", rubricMarkdown: null, prompt: null, typedQuestion: QUESTION, decisionThreshold: 0.6,
  executionBinding: structuredClone(JEV), outputSchema: TypedQuestionOutputSchema
};

function draft(overrides: Partial<EditorVersionDraft>): EditorVersionDraft {
  return {
    base: prompted, criterionVersionId: "cv",
    binding: { provider: "anthropic", modelId: SEEDED_DEFAULT_EXECUTION_BINDING.modelId, modelVersion: SEEDED_DEFAULT_EXECUTION_BINDING.modelVersion, baseUrl: "", temperature: "0" },
    rubricMarkdown: "# Guide", prompt: "Judge against {{rubric_markdown}}.",
    typedQuestion: { instructions: QUESTION.instructions, trueCriterion: "Grounded.", falseCriterion: "Not grounded.", threshold: "0.7" },
    verdict: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null },
    timeScope: "new", firstRun: false, starterSuppliedContract: false,
    ...overrides
  };
}

/** What the server does with the request: parse it, then refuse any definition that breaks the rules. */
function serverAccepts(input: unknown) {
  const parsed = CreateSkillVersionInputSchema.safeParse(input);
  return parsed.success ? evaluatorDefinitionInputIssues(parsed.data) : [{ path: "parse", message: parsed.error.message }];
}

describe("the editor's create-version request", () => {
  it("sends a typed question with the typesafe binding, a binary verdict, and the fixed contract", () => {
    const input = skillVersionInputFromDraft(draft({ binding: { provider: "typesafe", modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", baseUrl: "", temperature: "0" } }));
    expect(input).toMatchObject({ typedQuestion: QUESTION, decisionThreshold: 0.7, verdictKind: "binary", executionBinding: JEV, criterionVersionId: "cv" });
    expect(input).not.toHaveProperty("rubricMarkdown");
    expect(input).not.toHaveProperty("prompt");
    expect(isTypedQuestionOutputSchema(input!.outputSchema)).toBe(true);
    expect(serverAccepts(input)).toEqual([]);
  });

  it("sends nothing until the typed question is complete", () => {
    const typesafe = { provider: "typesafe" as const, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", baseUrl: "", temperature: "" };
    expect(skillVersionInputFromDraft(draft({ binding: typesafe, typedQuestion: EMPTY_TYPED_QUESTION_DRAFT }))).toBeNull();
    expect(skillVersionInputFromDraft(draft({ binding: typesafe, typedQuestion: { ...draft({}).typedQuestion, threshold: "" } }))).toBeNull();
  });

  it("gives a prompted version switched from a typed one the prompted contract, never the probability schema", () => {
    const input = skillVersionInputFromDraft(draft({ base: typed }));
    expect(input).toMatchObject({ rubricMarkdown: "# Guide", verdictKind: "binary" });
    expect(input).not.toHaveProperty("typedQuestion");
    expect(isTypedQuestionOutputSchema(input!.outputSchema)).toBe(false);
    expect(input!.outputSchema).toEqual(verdictOutputSchema({ verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }));
    expect(serverAccepts(input)).toEqual([]);
  });

  it("keeps a prompted base's contract when the result shape doesn't change", () => {
    const custom = { ...prompted, outputSchema: { ...MinimumVerdictOutputSchema, description: "kept" } };
    expect(skillVersionInputFromDraft(draft({ base: custom }))!.outputSchema).toEqual(custom.outputSchema);
    expect(serverAccepts(skillVersionInputFromDraft(draft({})))).toEqual([]);
  });
});
