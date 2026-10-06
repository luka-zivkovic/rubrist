import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ThumbsUp, PencilLine, Sparkles } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Eyebrow,
  SectionHead,
  VerdictChip,
  Chip,
  MarginNote,
  JudgeCallPanel
} from "@/components/rubrist";
import {
  promoteExceptionToGoldenSet,
  recordHumanVerdict
} from "@/lib/api";
import {
  effectiveHumanVerdict,
  payloadRationale,
  verdictLabelFromPayload,
  type CaseDatasetExpectation,
  type ExceptionDetail,
  type GoldenSetEntry,
  type TraceStep,
  type VerdictLabel,
  type VerdictPayload,
  type VerdictRecord
} from "@rubrist/shared";

import { ReviewEvidenceNavigation } from "./review-evidence-navigation.js";
import { AssessmentReasoning } from "./assessment-reasoning.js";
import { sourceMessageIndices } from "../lib/message-evidence.js";
import { ConversationEvidence } from "./conversation-evidence.js";
import { CaseEvidence } from "./case-evidence.js";
import { ModEvidenceView } from "./mod-evidence-view.js";
import { TypedQuestionView } from "./typed-question-view.js";
import { evidenceClaim, recordedTypedEvaluation, recordedVersionName } from "../lib/recorded-evaluation.js";

export type TraceDecisionKind = "accept" | "override" | "promote";

// Sequential review surfaces (the player) opt into keyboard shortcuts by
// passing navigation callbacks. A/O/P act on this component's own forms;
// S / arrows / esc are delegated to the host. Standalone case views pass
// nothing and stay shortcut-free.
export interface TraceDetailShortcuts {
  onSkip?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onExit?: () => void;
}

interface TraceDetailProps {
  reviewQueueItemId?: string | undefined;
  reviewTaskPending?: boolean;
  headingAs?: "h1" | "h2";
  detail: ExceptionDetail;
  // Called after a decision is recorded server-side, with which kind — hosts
  // use it to advance their cursor and tally a session summary.
  onChanged?: (kind: TraceDecisionKind) => void;
  openRulingOnMount?: boolean;
  shortcuts?: TraceDetailShortcuts;
}

type Decision = TraceDecisionKind | null;

const VERDICT_CHOICE_SCORES: Record<VerdictLabel, number> = {
  pass: 1,
  fail: 0,
  ambiguous: 0.5
};

const OVERRIDE_OPTIONS: ReadonlyArray<VerdictLabel> = ["pass", "fail", "ambiguous"];

// Result colors describe the recorded label. Review action colors describe
// agreement/change: agreeing with a FAIL must never look like recording PASS.
const REVIEW_RESULT_TONES: Record<VerdictLabel, { card: string; header: string; chip: string }> = {
  pass: {
    card: "border-emerald-700 dark:border-emerald-500",
    header: "bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100",
    chip: "border-emerald-700 bg-emerald-100 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-100"
  },
  fail: {
    card: "border-red-700 dark:border-red-400",
    header: "bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-100",
    chip: "border-red-700 bg-red-100 text-red-900 dark:border-red-400 dark:bg-red-950 dark:text-red-100"
  },
  ambiguous: {
    card: "border-amber-700 dark:border-amber-400",
    header: "bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
    chip: "border-amber-700 bg-amber-100 text-amber-900 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100"
  }
};

// the judge-named failing step for THIS case's latest judge run.
// rawResponse is the structured verdict recordJudgeRun persisted — read it
// defensively (unknown-typed; older runs predate the field).
function failingStepFromRawResponse(rawResponse: unknown): number | null {
  if (typeof rawResponse !== "object" || rawResponse === null) return null;
  const value = (rawResponse as { failingStep?: unknown }).failingStep;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// The step ledger (M2 T4): the supplied trajectory, numbered, with the
// judge-named failing step highlighted and YOUR dataset labels as chips —
// "your label", never "correct step" (a label is a claim, not ground truth).
function StepLedger({
  steps,
  failingStep,
  expectations
}: {
  steps: TraceStep[];
  failingStep: number | null;
  expectations: CaseDatasetExpectation[];
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const stepExpectations = expectations.filter((expectation) => expectation.expectedFailStep !== null);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Trajectory</CardTitle>
          <CardDescription>
            {steps.length} supplied step{steps.length === 1 ? "" : "s"} — judged as one case, one assessment.
          </CardDescription>
        </div>
        <div className="flex-1" />
        {expectations.length > 0 ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {expectations.map((expectation, index) => (
              <span key={`${expectation.datasetName}-${index}`} className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-3">
                your label · {expectation.datasetName}:
                {expectation.expectedLabel ? <VerdictChip verdict={expectation.expectedLabel} /> : <span>—</span>}
                {expectation.expectedFailStep !== null ? <span>@ step {expectation.expectedFailStep}</span> : null}
              </span>
            ))}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {steps.map((step, index) => {
          const isFailing = failingStep === index;
          const expectedHere = stepExpectations.filter((expectation) => expectation.expectedFailStep === index);
          const isOpen = open[index] ?? false;
          return (
            <div
              key={index}
              className={`rounded-sm border ${isFailing ? "border-signal-tint bg-signal-wash" : "border-rule-soft"}`}
              data-step-index={index}
            >
              <button
                type="button"
                onClick={() => setOpen((current) => ({ ...current, [index]: !isOpen }))}
                className="flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-card-2"
              >
                <span className="font-mono text-[10.5px] text-ink-3">{isOpen ? "▾" : "▸"}</span>
                <span className="font-mono text-[11px] text-ink-3">#{index}</span>
                <span className="text-[12.5px] text-ink-2">{step.name ?? "unnamed step"}</span>
                {isFailing ? (
                  <span className="rounded-sm border border-signal-tint px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] text-signal">
                    judge: failing step
                  </span>
                ) : null}
                {expectedHere.map((expectation, expectationIndex) => (
                  <span
                    key={expectationIndex}
                    className="rounded-sm border border-rule-soft px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-3"
                  >
                    your label · {expectation.datasetName}
                  </span>
                ))}
                <span className="flex-1" />
              </button>
              {isOpen ? (
                <div className="fadeUp flex flex-col gap-2 border-t border-rule-soft px-3 py-2.5">
                  <div>
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">Input</div>
                    <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink">
                      {formatPayload(step.input)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">Output</div>
                    <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink">
                      {formatPayload(step.output)}
                    </pre>
                  </div>
                  {step.metadata && Object.keys(step.metadata).length > 0 ? (
                    <div>
                      <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">Metadata</div>
                      <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink">
                        {formatPayload(step.metadata)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function categoricalPayload(choice: VerdictLabel, rationale: string): VerdictPayload {
  return {
    kind: "categorical",
    choice,
    choiceScores: { ...VERDICT_CHOICE_SCORES },
    rationale
  };
}

function verdictActor(verdict: VerdictRecord): string {
  if (verdict.source === "llm_judge") return "Evaluator";
  if (verdict.source === "imported_external") return "External source";
  return verdict.actorName || verdict.actorUserId || "Unknown reviewer";
}

function verdictSourceLabel(verdict: VerdictRecord): string {
  if (verdict.source === "adjudicated") return "Owner human label";
  if (verdict.source === "human") return "Human review";
  if (verdict.source === "llm_judge") return "Evaluator output";
  return "Imported label";
}

function HumanRulingCard({
  ruling,
  verdicts,
  currentJudgeRun
}: {
  ruling: VerdictRecord;
  verdicts: VerdictRecord[];
  currentJudgeRun: ExceptionDetail["judgeRun"];
}) {
  const label = verdictLabelFromPayload(ruling.payload);
  const priorEvaluatorVerdict = [...verdicts]
    .filter((verdict) =>
      verdict.source === "llm_judge" &&
      verdict.createdAt <= ruling.createdAt &&
      (!ruling.skillVersionId || verdict.skillVersionId === ruling.skillVersionId)
    )
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    )[0];
  const priorEvaluatorLabel = ruling.reviewContext
    ? (ruling.reviewContext.judgeRunId === currentJudgeRun.id ? currentJudgeRun.verdict : null)
    : priorEvaluatorVerdict
    ? verdictLabelFromPayload(priorEvaluatorVerdict.payload)
    : currentJudgeRun.createdAt <= ruling.createdAt &&
        (!ruling.skillVersionId || currentJudgeRun.skillVersionId === ruling.skillVersionId)
      ? currentJudgeRun.verdict
      : null;
  const agrees = priorEvaluatorLabel ? label === priorEvaluatorLabel : null;
  return (
    <Card data-testid="human-ruling-card" className={`border-2 ${REVIEW_RESULT_TONES[label].card}`}>
      <CardHeader className={REVIEW_RESULT_TONES[label].header}>
        <div>
          <CardTitle>{ruling.source === "adjudicated" ? "Owner human label" : "Recorded human label"}</CardTitle>
          <CardDescription className="text-inherit">
            Ungoverned legacy review evidence. This is not governed human truth.
          </CardDescription>
        </div>
        <VerdictChip verdict={label} className={`px-3 py-2 text-[24px] font-semibold tracking-tight ${REVIEW_RESULT_TONES[label].chip}`} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-[13px] text-ink-2">
          {agrees === null
            ? ruling.reviewContext ? "This human label refers to another recorded evaluator result." : "No evaluator output was recorded before this human label."
            : agrees
              ? `At review time, agreed with the evaluator's ${priorEvaluatorLabel} output.`
              : `At review time, overrode the evaluator's ${priorEvaluatorLabel} output.`}
        </div>
        <Separator />
        <div>
          <Eyebrow>Review rationale</Eyebrow>
          <div className="mt-1.5 text-[13px] leading-[1.55] text-ink-2">
            {payloadRationale(ruling.payload) || <span className="text-ink-3">No rationale recorded.</span>}
          </div>
        </div>
        <div className="font-mono text-[10.5px] text-ink-3">
          {verdictActor(ruling)} · {new Date(ruling.createdAt).toLocaleString()}
        </div>
        {ruling.source === "adjudicated" ? (
          <div className="text-[11px] text-ink-3">
            This owner human label takes precedence over ordinary human reviews in the legacy flow.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DecisionHistory({
  verdicts,
  effectiveRulingId,
  detail
}: {
  verdicts: VerdictRecord[];
  effectiveRulingId: string | null;
  detail: ExceptionDetail;
}) {
  if (verdicts.length === 0) return null;
  const versionName = recordedVersionName(detail);
  const effective = verdicts.find((verdict) => verdict.id === effectiveRulingId) ?? null;
  return (
    <Card>
      <CardContent className="py-3">
        <details>
          <summary className="cursor-pointer text-[12.5px] font-medium text-ink">
            Decision history · {verdicts.length} append-only record{verdicts.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-3 flex flex-col gap-2 border-t border-rule-soft pt-3">
            {verdicts.map((verdict) => {
              const label = verdictLabelFromPayload(verdict.payload);
              const isEffective = verdict.id === effectiveRulingId;
              const humanButLowerPriority = verdict.source === "human" && effective?.source === "adjudicated";
              return (
                <div key={verdict.id} className="rounded-sm border border-rule-soft bg-card-2 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <VerdictChip verdict={label} />
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
                      {verdictSourceLabel(verdict)}
                    </span>
                    {isEffective ? <Chip>effective human label</Chip> : null}
                    {humanButLowerPriority ? <Chip>does not override owner human label</Chip> : null}
                  </div>
                  <div className="mt-1.5 text-[12px] leading-[1.5] text-ink-2">
                    {(payloadRationale(verdict.payload) ?? "This evaluator states no rationale.") || "No rationale recorded."}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-ink-3">
                    {verdict.source === "llm_judge" ? `Model: ${verdict.observed?.model ?? "not recorded"}` : verdictActor(verdict)} · {new Date(verdict.createdAt).toLocaleString()}
                    {verdict.reviewContext ? <div className="mt-1 break-all">Review task {verdict.reviewContext.queueItemId} · recorded result {verdict.reviewContext.judgeRunId}</div> : null}
                    {verdict.skillVersionId ? (
                      <div className="mt-1 break-all">Evaluator version {verdict.skillVersionId === detail.judgeRun.skillVersionId && versionName ? `v${versionName} · ` : ""}{verdict.skillVersionId}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

export function TraceDetail({ reviewQueueItemId, reviewTaskPending = false, detail, onChanged, shortcuts, openRulingOnMount = false, headingAs = "h1" }: TraceDetailProps) {
  const { exception, trace, judgeRun, rawRequest, rawResponse } = detail;
  const typedEvaluation = recordedTypedEvaluation(detail);
  const structuredEvidence = evidenceClaim(trace.input, trace.output);
  const versionName = recordedVersionName(detail);
  const evidencePrefix = useId();
  const [inspectedMessage, setInspectedMessage] = useState<{ caseId: string; judgeRunId: string; index: number; origin: "evaluator" | "navigation" } | null>(null);
  useEffect(() => { setInspectedMessage(null); }, [exception.id, judgeRun.id]);
  const sourceIndices = structuredEvidence ? [] : sourceMessageIndices(trace.input, trace.metadata);
  function inspectMessage(index: number, origin: "evaluator" | "navigation" = "evaluator") {
    setInspectedMessage({ caseId: exception.id, judgeRunId: judgeRun.id, index, origin });
    const target = document.getElementById(`${evidencePrefix}-${index}`);
    // Referenced instructions may be collapsed; tool responses are always visible.
    const instructions = target?.querySelector<HTMLDetailsElement>(":scope > details");
    if (instructions) instructions.open = true;
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }

  function inspectSection(section: "evidence" | "assessment" | "review") {
    const target = document.getElementById(`${evidencePrefix}-${section}`);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }

  const [decision, setDecision] = useState<Decision>(null);
  const [overrideChoice, setOverrideChoice] = useState<VerdictLabel>("fail");
  const [overrideReason, setOverrideReason] = useState("");
  const [promoteReason, setPromoteReason] = useState(exception.reason);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resultText, setResultText] = useState<string | null>(null);
  const [verdictHistory, setVerdictHistory] = useState<VerdictRecord[]>(detail.verdictHistory);
  const [goldenSetEntry, setGoldenSetEntry] = useState<GoldenSetEntry | null>(detail.goldenSetEntry);

  const effectiveRuling = useMemo(() => effectiveHumanVerdict(verdictHistory), [verdictHistory]);
  const effectiveRulingLabel = effectiveRuling ? verdictLabelFromPayload(effectiveRuling.payload) : null;
  // A regression-reference reason should describe the recorded human ruling
  // when one exists, not repeat the evaluator rationale that it overturned.
  const promoteReasonPrefill = (effectiveRuling && payloadRationale(effectiveRuling.payload)) || exception.reason;

  // Reset all per-case state when the user navigates to a different case.
  // Deps are intentionally narrow: just exception.id. Reload-after-decide
  // (onChanged → parent refetches the same caseId) keeps resultText visible
  // so the user can see "Verdict accepted" instead of having it flash and
  // disappear when the parent swaps in a new ExceptionDetail object.
  useEffect(() => {
    setDecision(null);
    setOverrideChoice(
      exception.verdict === "fail" ? "pass" : exception.verdict === "pass" ? "fail" : "pass"
    );
    setOverrideReason("");
    setPromoteReason(promoteReasonPrefill);
    setSubmitting(false);
    setSubmitError(null);
    setResultText(null);
    setVerdictHistory(detail.verdictHistory);
    setGoldenSetEntry(detail.goldenSetEntry);
  }, [exception.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A same-case reload after a write supplies the authoritative append-only
  // history (promotion itself also appends a human verdict server-side).
  useEffect(() => {
    setVerdictHistory(detail.verdictHistory);
    setGoldenSetEntry(detail.goldenSetEntry);
  }, [detail.verdictHistory, detail.goldenSetEntry]);

  // The label a promotion freezes. A recorded human verdict (override or
  // adjudication) outranks the judge's label — promoting must never enshrine
  // a verdict the team already overturned on this case. null = not promotable
  // (the effective label is ambiguous; record a pass/fail verdict first).
  const promotionSource: "human" | "skill" = effectiveRuling ? "human" : "skill";
  const promotionLabel = effectiveRulingLabel ?? exception.verdict;
  const promoteLabel = promotionLabel === "ambiguous" ? null : promotionLabel;
  const promoteEligible = promoteLabel !== null;

  const rawRequestStr = useMemo(
    () => (rawRequest !== undefined ? formatPayload(rawRequest) : undefined),
    [rawRequest]
  );
  const rawResponseStr = useMemo(
    () => (rawResponse !== undefined ? formatPayload(rawResponse) : undefined),
    [rawResponse]
  );

  // Judge call meta (M0 C6): recordJudgeRun persists {provider, modelName,
  // prompt{content}, …} in raw_request and the wall-clock latency on the run —
  // surface model + latency + the compiled prompt instead of the hardcoded
  // empty meta that rendered every case as "No call meta available". Older
  // runs (before raw_request/latency existed) degrade to the empty state.
  const judgeCallMeta = useMemo(() => {
    const request = rawRequest as { provider?: unknown; modelName?: unknown; prompt?: { name?: unknown; content?: unknown } } | undefined;
    const provider = typeof request?.provider === "string" ? request.provider : undefined;
    const modelName = typeof request?.modelName === "string" ? request.modelName : undefined;
    const requestedModelLabel = provider && modelName ? `${provider}/${modelName}` : modelName ?? provider;
    const skillVersion = typeof request?.prompt?.name === "string" ? request.prompt.name : undefined;
    const observed = judgeRun.providerMetadata;
    return {
      ...(requestedModelLabel ? { requestedModelLabel } : {}),
      ...(skillVersion ? { skillVersion } : {}),
      ...(observed ? {
        observedModel: observed.model,
        requestId: observed.requestId,
        responseId: observed.responseId,
        systemFingerprint: observed.systemFingerprint
      } : {}),
      ...(judgeRun.latencyMs !== undefined ? { latencyMs: judgeRun.latencyMs } : {})
    };
  }, [rawRequest, judgeRun.latencyMs, judgeRun.providerMetadata]);
  const compiledPrompt = useMemo(() => {
    const request = rawRequest as { prompt?: { content?: unknown } } | undefined;
    return typeof request?.prompt?.content === "string" ? request.prompt.content : undefined;
  }, [rawRequest]);

  // Keep the same key after a lost response; a changed payload starts a new submission.
  const pendingSubmission = useRef<{ payload: string; id: string } | null>(null);
  const reviewContext = (payload: VerdictPayload) => {
    if (!reviewQueueItemId) return undefined;
    const key = JSON.stringify([reviewQueueItemId, judgeRun.id, payload]);
    if (pendingSubmission.current?.payload !== key) pendingSubmission.current = { payload: key, id: crypto.randomUUID() };
    return { queueItemId: reviewQueueItemId, judgeRunId: judgeRun.id, submissionId: pendingSubmission.current.id };
  };

  const resetForms = () => {
    setOverrideReason("");
    setPromoteReason(promoteReasonPrefill);
    setSubmitError(null);
  };

  const openReviewForm = () => {
    const currentLabel = reviewQueueItemId ? exception.verdict : effectiveRulingLabel ?? exception.verdict;
    setOverrideChoice(currentLabel === "fail" ? "pass" : currentLabel === "pass" ? "fail" : "pass");
    setDecision("override");
    resetForms();
    setResultText(null);
  };

  const handleAccept = async () => {
    setDecision("accept");
    resetForms();
    setSubmitting(true);
    setResultText(null);
    try {
      const payload = categoricalPayload(exception.verdict, "Reviewer accepted skill verdict.");
      const verdict = await recordHumanVerdict(
        exception.id, payload, judgeRun.skillVersionId, reviewContext(payload),
      );
      pendingSubmission.current = null;
      setVerdictHistory((current) => [verdict, ...current.filter((item) => item.id !== verdict.id)]);
      setResultText(reviewQueueItemId ? "Review saved for this task. Earlier human labels remain in the case history." : "Assessment accepted. Recorded as a human label on the case.");
      onChanged?.("accept");
    } catch (err) {
      // Roll the button back so it doesn't stay primary-styled with no retry
      // affordance. The error sits above; user can click Accept again.
      setDecision(null);
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleOverrideSubmit = async () => {
    if (!overrideReason.trim()) {
      setSubmitError("Override reason is required.");
      return;
    }
    const currentLabel = effectiveRulingLabel ?? exception.verdict;
    if (!reviewQueueItemId && overrideChoice === currentLabel) {
      setSubmitError(`Pick a different label than the current ${effectiveRuling ? "human label" : "assessment"}.`);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setResultText(null);
    try {
      const payload = categoricalPayload(overrideChoice, overrideReason.trim());
      const verdict = await recordHumanVerdict(
        exception.id, payload, judgeRun.skillVersionId, reviewContext(payload),
      );
      pendingSubmission.current = null;
      setVerdictHistory((current) => [verdict, ...current.filter((item) => item.id !== verdict.id)]);
      setResultText(effectiveRuling?.source === "adjudicated"
        ? "Additional human review recorded. The owner human label still takes precedence."
        : `Human label changed to ${overrideChoice}. Recorded on the case.`);
      // Close the sub-form and clear the reason so the user can't accidentally
      // re-submit a duplicate verdict on the same case. The success banner
      // sits above and remains visible until the user navigates away.
      setDecision(null);
      setOverrideReason("");
      onChanged?.("override");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePromoteSubmit = async () => {
    if (promoteLabel === null) {
      setSubmitError("Only pass/fail labels can be promoted to the golden set.");
      return;
    }
    if (!promoteReason.trim()) {
      setSubmitError("Promotion reason is required.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setResultText(null);
    try {
      const entry = await promoteExceptionToGoldenSet(exception.id, {
        skillVersionId: judgeRun.skillVersionId,
        agreedLabel: promoteLabel,
        reason: promoteReason.trim()
      });
      setGoldenSetEntry(entry);
      setResultText("Added to the golden set as a golden case for future evaluator versions.");
      // Same anti-double-submit cleanup as override.
      setDecision(null);
      onChanged?.("promote");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (openRulingOnMount) openReviewForm();
  }, [openRulingOnMount]); // A return from the save receipt opens a new append-only correction.

  // Keyboard shortcuts (player mode only). The handler closure is stashed in a
  // ref so the window listener registers once per mount instead of re-binding
  // on every keystroke-triggered re-render.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (!shortcuts || e.metaKey || e.ctrlKey || e.altKey || e.repeat || submitting) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)) return;

    const key = e.key.toLowerCase();
    if (key === "a" && !submitting && (!effectiveRuling || reviewQueueItemId)) void handleAccept();
    else if (key === "o" && !submitting) {
      openReviewForm();
    } else if (key === "p" && !submitting && promoteEligible && !goldenSetEntry) {
      setDecision("promote");
      resetForms();
      setResultText(null);
    } else if (key === "s") shortcuts.onSkip?.();
    else if (key === "arrowright" || key === "j") shortcuts.onNext?.();
    else if (key === "arrowleft" || key === "k") shortcuts.onPrev?.();
    else if (key === "escape") {
      // esc closes an open sub-form before it exits the player.
      if (decision) setDecision(null);
      else shortcuts.onExit?.();
    }
  };
  const shortcutsEnabled = Boolean(shortcuts);
  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handler = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcutsEnabled]);

  return (
    <>
      <SectionHead
        headingAs={headingAs}
        eyebrow={`Case · ${exception.capabilityGap?.toLowerCase() ?? "uncategorized"}`}
        title={exception.title}
        sub={<span className="[overflow-wrap:anywhere]">{`Captured ${new Date(exception.createdAt).toLocaleString()} · trace ${trace.id}`}</span>}
      />

      <ReviewEvidenceNavigation key={`${exception.id}-${judgeRun.id}`} input={trace.input} metadata={trace.metadata}
        structured={Boolean(structuredEvidence)} onSection={inspectSection} onMessage={index => inspectMessage(index, "navigation")} />
      <div className="grid grid-cols-1 items-start gap-5 pb-36 xl:grid-cols-[1.25fr_1fr] xl:grid-rows-[auto_1fr] xl:pb-0">
        <div className="min-w-0 flex flex-col gap-5 xl:col-start-2 xl:row-start-1">
          {effectiveRuling ? (
            <HumanRulingCard
              ruling={effectiveRuling}
              verdicts={verdictHistory}
              currentJudgeRun={judgeRun}
            />
          ) : null}

          <Card id={`${evidencePrefix}-assessment`} tabIndex={-1} className={`scroll-mt-48 xl:scroll-mt-24 ${effectiveRuling ? "border-rule" : `border-2 ${REVIEW_RESULT_TONES[exception.verdict].card}`}`}>
            <CardHeader className={effectiveRuling ? undefined : REVIEW_RESULT_TONES[exception.verdict].header}>
              <div>
                <CardTitle className="text-[16px] font-semibold">{reviewQueueItemId ? "Recorded assessment" : "Latest assessment"}</CardTitle>
                <CardDescription className={effectiveRuling ? undefined : "text-inherit"}>
                  {reviewQueueItemId ? "Model output from the recorded result for this task." : "Model output from the latest judge run."} A recorded human label takes precedence in this view.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <VerdictChip verdict={exception.verdict} className={`${REVIEW_RESULT_TONES[exception.verdict].chip} ${effectiveRuling ? "text-[14px]" : "px-3 py-2 text-[24px] font-semibold tracking-tight"}`} />
                <span className="text-[14px] font-medium text-ink">
                  {typedEvaluation?.probability != null
                    ? `Probability answer is true: ${(typedEvaluation.probability * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
                    : `score ${judgeRun.score.toFixed(2)}`}
                </span>
                {effectiveRulingLabel ? (
                  <Chip>{effectiveRulingLabel === exception.verdict ? "agrees with human label" : "overridden by human label"}</Chip>
                ) : null}
              </div>

              <div className="text-[11.5px] text-ink-3">
                Model: {judgeRun.providerMetadata?.model ?? "not recorded"}
                <div className="mt-1 break-all">Evaluator version {versionName ? `v${versionName}` : judgeRun.skillVersionId}</div>
              </div>
              {typedEvaluation ? (
                <div className="text-[12px] text-ink-3">
                  {typedEvaluation.probability !== null
                    ? `True means pass. This version passes when the probability is at least ${typedEvaluation.threshold}. This is a model estimate, not measured accuracy.`
                    : "The recorded probability and threshold could not be verified from this call; inspect the raw evaluator record."}
                </div>
              ) : null}
              <Separator />

              <div>
                <Eyebrow>Reasoning</Eyebrow>
                <div className="mt-1.5 text-[13px] leading-[1.55] text-ink-2">
                  {judgeRun.reasoning === null
                    ? <span className="text-ink-3">{typedEvaluation ? "This evaluator returns a probability and does not provide an explanation." : "This evaluator states no rationale."}</span>
                    : judgeRun.reasoning ? <AssessmentReasoning text={judgeRun.reasoning} sourceIndices={sourceIndices} targetPrefix={evidencePrefix} onInspect={inspectMessage} /> : <span className="text-ink-3">No rationale recorded.</span>}
                </div>
                {sourceIndices.length > 0 ? <p className="mt-3 text-[11.5px] text-ink-3">Linked message numbers open the recorded evidence. Check whether it supports the evaluator’s reasoning.</p> : null}
              </div>

              {exception.capabilityGap ? <div>
                <Eyebrow>Capability gap</Eyebrow>
                <div className="mt-1 font-mono text-[12px] text-ink-2">
                  {exception.capabilityGap}
                </div>
              </div> : null}
            </CardContent>
          </Card>
        </div>
        <div id={`${evidencePrefix}-evidence`} tabIndex={-1} className="min-w-0 scroll-mt-48 flex flex-col gap-5 xl:scroll-mt-24 xl:col-start-1 xl:row-start-1 xl:row-span-2">
          <ModEvidenceView key={`mod-${exception.id}-${judgeRun.id}`} input={trace.input} output={trace.output} steps={trace.steps}
            metadata={trace.metadata} evaluatorFailingStep={failingStepFromRawResponse(rawResponse)} />
          {structuredEvidence ? <CaseEvidence input={trace.input} output={trace.output} steps={trace.steps} /> : (
            <ConversationEvidence
              key={`${exception.id}-${judgeRun.id}`}
              input={trace.input}
              metadata={trace.metadata}
              targetPrefix={evidencePrefix}
              selectedIndex={inspectedMessage?.caseId === exception.id && inspectedMessage.judgeRunId === judgeRun.id ? inspectedMessage.index : null}
              selectionOrigin={inspectedMessage?.origin}
              output={trace.output}
              steps={trace.steps}
              trajectory={trace.steps && trace.steps.length > 0 ? (
                <StepLedger key={exception.id} steps={trace.steps}
                  failingStep={failingStepFromRawResponse(rawResponse)} expectations={detail.datasetExpectations} />
              ) : undefined}
            />
          )}

          {structuredEvidence && trace.steps && trace.steps.length > 0 ? (
            <StepLedger key={exception.id} steps={trace.steps}
              failingStep={failingStepFromRawResponse(rawResponse)} expectations={detail.datasetExpectations} />
          ) : null}

          {exception.capabilityGap ? (
            <MarginNote
              tone="neutral"
              who={`Reviewer guide · ${exception.capabilityGap.toLowerCase()}`}
            >
              The evaluator flagged this case as <b>{exception.verdict}</b>. Check the reviewer guide
              or your team's playbook before accepting or overriding.
            </MarginNote>
          ) : null}
        </div>

        <div className="min-w-0 flex flex-col gap-5 xl:col-start-2 xl:row-start-2">
          <Card id={`${evidencePrefix}-review`} tabIndex={-1} className="scroll-mt-48 border-rule-strong xl:scroll-mt-24">
            <CardHeader>
              <div>
                <CardTitle className="text-[16px] font-semibold">{reviewTaskPending ? "Record your review" : effectiveRuling ? `Labeled ${effectiveRulingLabel}` : "Record your human label"}</CardTitle>
                <CardDescription>
                  {reviewTaskPending
                    ? "Earlier human labels are case history. Record your review of this result to complete this task."
                    : effectiveRuling
                    ? "The human label is saved on this case. Record another review or add it as a separate golden case."
                    : `The evaluator said ${exception.verdict.toUpperCase()}. Agree to record the same human label, or disagree to choose another.`}
                </CardDescription>
              </div>
              {goldenSetEntry ? <Chip>in golden set</Chip> : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {!effectiveRuling || reviewQueueItemId ? (
                  <Button
                    className="h-auto min-h-11 w-full justify-start whitespace-normal border-blue-200 bg-blue-50 px-3 py-2 text-left text-ink hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink dark:border-blue-400/25 dark:bg-blue-500/10 dark:hover:bg-blue-500/15 [&_svg]:text-blue-700 dark:[&_svg]:text-blue-300"
                    onClick={() => void handleAccept()}
                    disabled={submitting}
                  >
                    <ThumbsUp aria-hidden="true" />
                    <span>
                      <span className="block text-[13px] font-medium">{submitting && decision === "accept" ? "Recording agreement…" : `Agree with assessment: ${exception.verdict === "pass" ? "Pass" : exception.verdict === "fail" ? "Fail" : "Ambiguous"}`}</span>
                      <span className="block text-[11px] text-ink-3">Record this as my human label</span>
                    </span>
                  </Button>
                ) : null}
                <Button
                  className="h-auto min-h-11 w-full justify-start whitespace-normal border-amber-200 bg-amber-50 px-3 py-2 text-left text-ink hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink dark:border-amber-400/25 dark:bg-amber-500/10 dark:hover:bg-amber-500/15 [&_svg]:text-amber-800 dark:[&_svg]:text-amber-300"
                  onClick={openReviewForm}
                  disabled={submitting}
                >
                  <PencilLine aria-hidden="true" />
                  <span>
                    <span className="block text-[13px] font-medium">{effectiveRuling?.source === "adjudicated" ? "Add another review" : effectiveRuling ? "Change human label" : "Correct assessment"}</span>
                    <span className="block text-[11px] text-ink-3">Choose a different human label and explain why</span>
                  </span>
                </Button>
              </div>


              {decision === "override" ? (
                <div className="fadeUp flex flex-col gap-2">
                  <Eyebrow>{effectiveRuling ? "Choose the new human label" : "Choose your human label"}</Eyebrow>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Human label">
                    {OVERRIDE_OPTIONS.map((opt) => {
                      const isCurrent = !reviewQueueItemId && opt === (effectiveRulingLabel ?? exception.verdict);
                      const active = overrideChoice === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={isCurrent}
                          title={isCurrent ? "This is already the current human label." : undefined}
                          onClick={() => setOverrideChoice(opt)}
                          className={`inline-flex h-6 items-center rounded-sm border px-2 text-[11.5px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                            active
                              ? "border-ink bg-ink text-paper"
                              : "border-rule-soft bg-transparent text-ink-2 hover:bg-paper-3"
                          }`}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    className="min-h-[88px] w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-sans text-[12.5px] text-ink focus-visible:border-ink"
                    placeholder={reviewQueueItemId ? "Explain your human label on this recorded result (required)" : effectiveRuling ? "Why are you recording a different review? (required)" : "Why is your human label different from the evaluator? (required)"}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                  <div className="text-[11px] text-ink-3">
                    The rationale is stored with this append-only review record. Earlier decisions remain visible.
                    {effectiveRuling?.source === "adjudicated"
                      ? " An ordinary review cannot replace the owner human label."
                      : ""}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleOverrideSubmit()}
                      disabled={submitting || !overrideReason.trim()}
                    >
                      Record {overrideChoice.toUpperCase()} human label
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDecision(null)}
                      disabled={submitting}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="border-t border-rule-soft pt-3">
                <Button
                  variant={decision === "promote" ? "primary" : "ghost"}
                  onClick={() => {
                    setDecision("promote");
                    resetForms();
                    setResultText(null);
                  }}
                  disabled={submitting || !promoteEligible || Boolean(goldenSetEntry)}
                  title={goldenSetEntry
                    ? "This case is already an active golden case."
                    : promoteEligible ? undefined : "Only pass/fail labels can be added."}
                >
                  <Sparkles /> {goldenSetEntry ? "In golden set" : "Add to golden set"}
                </Button>
              </div>

              {decision === "promote" ? (
                <div className="fadeUp flex flex-col gap-2">
                  <textarea
                    className="min-h-[88px] w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-sans text-[12.5px] text-ink focus-visible:border-ink"
                    placeholder="Why should future evaluator versions be tested against this case? (required)"
                    value={promoteReason}
                    onChange={(e) => setPromoteReason(e.target.value)}
                  />
                  <div className="flex gap-1.5">
                    <Chip variant={promoteLabel === "fail" ? "fail" : "pass"}>
                      label · {promoteLabel}
                    </Chip>
                    <Chip>{promotionSource === "human" ? "from human label" : "from assessment"}</Chip>
                    {exception.capabilityGap ? (
                      <Chip>category · {exception.capabilityGap.toLowerCase()}</Chip>
                    ) : null}
                    <Chip>golden case</Chip>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handlePromoteSubmit()}
                      disabled={submitting || !promoteReason.trim()}
                    >
                      Add golden case
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDecision(null)}
                      disabled={submitting}
                    >
                      Cancel
                    </Button>
                  </div>
                  <div className="text-[11px] text-ink-3">
                    This is a separate golden-set transaction. It freezes a known-case expectation for regression testing; it does not create governed human truth.
                  </div>
                </div>
              ) : null}

              {submitError ? (
                <div className="text-[12px] text-signal">{submitError}</div>
              ) : null}
              {resultText ? <div className="text-[12px] text-ink-2">{resultText}</div> : null}
              {!decision && !resultText ? (
                <div className="text-[12px] text-ink-3">
                  {goldenSetEntry
                    ? `Golden-set expectation: ${goldenSetEntry.agreedLabel}. ${goldenSetEntry.reason} Added by ${goldenSetEntry.promotedBy} on ${new Date(goldenSetEntry.promotedAt).toLocaleString()}.`
                    : effectiveRuling
                      ? "The human label is durable. Add a separate golden case only if future versions should be checked against this case."
                      : "Record a human label before moving on. Golden-set promotion is a separate regression action."}
                </div>
              ) : null}
              {shortcuts ? <KeyLegend hasRuling={Boolean(effectiveRuling)} inGoldenSet={Boolean(goldenSetEntry)} /> : null}
            </CardContent>
          </Card>
          {typedEvaluation ? (
            <details key={`question-${exception.id}-${judgeRun.id}`} className="rounded-sm border border-rule-soft bg-card">
              <summary className="cursor-pointer px-[18px] py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2">Typed question and decision threshold</summary>
              <div className="border-t border-rule-soft px-[18px] py-4">
                <TypedQuestionView question={typedEvaluation.question} threshold={typedEvaluation.threshold} />
              </div>
            </details>
          ) : null}

          <details key={`call-${exception.id}-${judgeRun.id}`} className="rounded-sm border border-rule-soft bg-card">
            <summary className="cursor-pointer px-[18px] py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2">Judge call and version details</summary>
            <div className="px-[18px] pb-3 text-[11.5px] text-ink-3 break-all">Evaluator version {judgeRun.skillVersionId}</div>
            <JudgeCallPanel
              meta={judgeCallMeta}
              compiledPrompt={compiledPrompt}
              rawRequest={rawRequestStr}
              rawResponse={rawResponseStr}
            />
          </details>

          <DecisionHistory
            verdicts={verdictHistory}
            effectiveRulingId={effectiveRuling?.id ?? null}
            detail={detail}
          />
        </div>
      </div>
    </>
  );
}

function KeyLegend({ hasRuling, inGoldenSet }: { hasRuling: boolean; inGoldenSet: boolean }) {
  const item = "flex items-center gap-1.5 text-[11px] text-ink-3";
  const kb =
    "inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-rule-soft px-1 font-mono text-[10px] text-ink-2";
  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-sm border border-rule-soft px-3 py-2">
      <div className="flex justify-between gap-3">
        {!hasRuling ? (
          <span className={item}>
            <span className={kb}>A</span> agree
          </span>
        ) : null}
        <span className={item}>
          <span className={kb}>O</span> {hasRuling ? "review again" : "disagree"}
        </span>
        {!inGoldenSet ? (
          <span className={item}>
            <span className={kb}>P</span> add to golden
          </span>
        ) : null}
        <span className={item}>
          <span className={kb}>S</span> skip
        </span>
      </div>
      <div className="flex justify-between gap-3">
        <span className={item}>
          <span className={kb}>←</span> <span className={kb}>→</span> navigate
        </span>
        <span className={item}>
          <span className={kb}>esc</span> exit
        </span>
      </div>
    </div>
  );
}
