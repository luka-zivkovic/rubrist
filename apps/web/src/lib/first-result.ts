import type { EvalRun, VerdictRecord } from "@rubrist/shared";

export function firstAssessmentRunForVersion(runs: EvalRun[], skillVersionId: string, recordedVerdicts: VerdictRecord[] = []): EvalRun | null {
  // A recorded assessment already completes onboarding; a later failed or
  // pending import must not hide it behind an unrelated run.
  if (recordedVerdicts.some((verdict) => verdict.skillVersionId === skillVersionId && verdict.source === "llm_judge")) return null;
  const eligible = runs.filter((run) =>
    run.skillVersionId === skillVersionId &&
    (run.trigger === "backfill" || (run.trigger === "api_batch" && run.datasetId === null))
  );
  return eligible.find((run) => run.status === "pending" || run.status === "running") ?? eligible[0] ?? null;
}

export function verdictForTrackedItem(
  verdicts: VerdictRecord[],
  verdictId: string
): VerdictRecord | null {
  return verdicts.find((verdict) => verdict.id === verdictId) ?? null;
}
