import { useId, type Dispatch, type SetStateAction } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow } from "@/components/rubrist";
import {
  TYPED_CRITERION_MAX,
  TYPED_QUESTION_MAX,
  typedQuestionDraftProblems,
  type TypedQuestionDraft
} from "../../lib/typed-question-draft.js";

// The typed-question definition (ADR-0014 section 5, Batch 8F): what the
// editor shows in place of the review guide and judge instructions when the
// evaluator runs on TypeSafe.

const textareaClass = "w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5 text-[12.5px] leading-[1.6] text-ink focus-visible:border-ink";

export function TypedQuestionCard({
  draft,
  setDraft
}: {
  draft: TypedQuestionDraft;
  setDraft: Dispatch<SetStateAction<TypedQuestionDraft>>;
}) {
  const id = useId();
  const problems = typedQuestionDraftProblems(draft);
  const change = (field: keyof TypedQuestionDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const field = (name: string) => `${id}-${name}`;
  const problemsId = field("problems");
  // A field is invalid once it holds text the contract refuses; an empty one is only unfinished.
  const invalid = (part: string, value: string) =>
    value.trim() !== "" && problems.some((problem) => problem.includes(part)) ? true : undefined;
  const described = problems.length > 0 ? problemsId : undefined;
  return (
    <Card className="mb-5">
      <CardHeader>
        <div>
          <CardTitle>Typed question</CardTitle>
          <CardDescription>
            TypeSafe answers one yes-or-no question with the probability that the answer is true.
            The verdict is pass when that probability reaches the threshold, and fail otherwise; it
            never abstains and states no rationale. Ask about one property of the reply, with a
            clear line between true and false. The typed-question guide says which criteria a single
            question suits, and how to choose the threshold.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Eyebrow id={field("question-label")}>Question</Eyebrow>
          <textarea
            aria-labelledby={field("question-label")}
            aria-describedby={described}
            aria-invalid={invalid("the question", draft.instructions)}
            maxLength={TYPED_QUESTION_MAX}
            value={draft.instructions}
            onChange={(event) => change("instructions")(event.target.value)}
            placeholder="Does the reply answer in the language the user wrote in?"
            className={`${textareaClass} min-h-[90px]`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Eyebrow id={field("true-label")}>True when</Eyebrow>
          <textarea
            aria-labelledby={field("true-label")}
            aria-describedby={described}
            aria-invalid={invalid("answer true", draft.trueCriterion)}
            maxLength={TYPED_CRITERION_MAX}
            value={draft.trueCriterion}
            onChange={(event) => change("trueCriterion")(event.target.value)}
            placeholder="The reply is in the user's language."
            className={`${textareaClass} min-h-[70px]`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Eyebrow id={field("false-label")}>False when</Eyebrow>
          <textarea
            aria-labelledby={field("false-label")}
            aria-describedby={described}
            aria-invalid={invalid("answer false", draft.falseCriterion)}
            maxLength={TYPED_CRITERION_MAX}
            value={draft.falseCriterion}
            onChange={(event) => change("falseCriterion")(event.target.value)}
            placeholder="The reply is in another language."
            className={`${textareaClass} min-h-[70px]`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Eyebrow id={field("threshold-label")}>Decision threshold</Eyebrow>
          {/* Text rather than a number field: no stepping, no wheel changes, and a decimal comma reads as a point. */}
          <input
            type="text"
            inputMode="decimal"
            aria-labelledby={field("threshold-label")}
            aria-describedby={`${field("threshold-hint")}${described ? ` ${described}` : ""}`}
            aria-invalid={invalid("decision threshold", draft.threshold)}
            value={draft.threshold}
            placeholder="choose one"
            onChange={(event) => change("threshold")(event.target.value)}
            className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
          />
          <span id={field("threshold-hint")} className="text-[11px] leading-5 text-ink-3">
            Pass when p ≥ this value, above 0 and below 1. Choose it on development cases, not on the
            golden set that checks this version; it has no default, and changing it makes a new version.
          </span>
        </div>
        {problems.length > 0 ? (
          <ul id={problemsId} className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-ink-3 sm:col-span-2">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
