import { TypedQuestionSchema, containsLoneUtf16Surrogate, type SkillVersion, type TypedQuestion } from "@rubrist/shared";

// The editor's typed-question fields (ADR-0014 section 5, Batch 8F): a binary
// `noul` question, what makes its answer true and false, and the decision
// threshold. The author chooses the threshold on nonsealed data; it has no
// default (founder decision 4).

export interface TypedQuestionDraft {
  instructions: string;
  trueCriterion: string;
  falseCriterion: string;
  /** Empty until the author chooses one. */
  threshold: string;
}

export const EMPTY_TYPED_QUESTION_DRAFT: TypedQuestionDraft = {
  instructions: "",
  trueCriterion: "",
  falseCriterion: "",
  threshold: ""
};

/** A saved version's question and threshold as editor fields; empty for a prompted version. */
export function typedQuestionDraftFrom(version: Pick<SkillVersion, "typedQuestion" | "decisionThreshold">): TypedQuestionDraft {
  if (version.typedQuestion === null) return EMPTY_TYPED_QUESTION_DRAFT;
  return {
    instructions: version.typedQuestion.instructions,
    trueCriterion: version.typedQuestion.criteria.true,
    falseCriterion: version.typedQuestion.criteria.false,
    threshold: version.decisionThreshold === null ? "" : String(version.decisionThreshold)
  };
}

/** The longest question and criterion text the typed-question contract takes. */
export const TYPED_QUESTION_MAX = 20_000;
export const TYPED_CRITERION_MAX = 5_000;

function parsedThreshold(text: string): number | null {
  // A decimal comma, as some locales type it, reads as a point.
  const trimmed = text.trim().replace(",", ".");
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

/** Text the definition can't hold: a NUL or an unpaired UTF-16 surrogate. */
function unsupportedText(value: string): boolean {
  return value.includes("\u0000") || containsLoneUtf16Surrogate(value);
}

function textProblem(value: string, part: string, max: number, missing: string): string | null {
  if (value.trim() === "") return missing;
  if (value.length > max) return `Shorten ${part} to ${max.toLocaleString("en-US")} characters.`;
  if (unsupportedText(value)) return `Remove the unsupported characters from ${part}.`;
  return null;
}

/** What the author still has to fix before the draft can be saved; empty when it can. */
export function typedQuestionDraftProblems(draft: TypedQuestionDraft): string[] {
  return [
    textProblem(draft.instructions, "the question", TYPED_QUESTION_MAX, "Write the question."),
    textProblem(draft.trueCriterion, "what makes the answer true", TYPED_CRITERION_MAX, "Say what makes the answer true."),
    textProblem(draft.falseCriterion, "what makes the answer false", TYPED_CRITERION_MAX, "Say what makes the answer false."),
    parsedThreshold(draft.threshold) === null ? "Choose a decision threshold above 0 and below 1, on development cases." : null
  ].filter((problem): problem is string => problem !== null);
}

/** The question and threshold a typed-question version saves, or `null` while the draft has problems. */
export function typedQuestionFromDraft(draft: TypedQuestionDraft): { typedQuestion: TypedQuestion; decisionThreshold: number } | null {
  if (typedQuestionDraftProblems(draft).length > 0) return null;
  const decisionThreshold = parsedThreshold(draft.threshold);
  const typedQuestion = TypedQuestionSchema.safeParse({
    type: "noul",
    instructions: draft.instructions,
    criteria: { true: draft.trueCriterion, false: draft.falseCriterion }
  });
  if (decisionThreshold === null || !typedQuestion.success) return null;
  return { typedQuestion: typedQuestion.data, decisionThreshold };
}
