import type { Queue } from "@rubrist/queue";
import {
  ImportSkillVersionBindingError,
  NoCurrentSkillError,
  type RubristRepository
} from "../repository.js";
import { dispatchEvalRunOnce } from "./gate.js";

export interface ImportedCaseJudgingResult {
  scheduledCaseCount: number;
  evalRunIds: string[];
  backfillRunId: string | null;
  dispatchPending: boolean;
}

export async function assertImportJudgingAllowed(
  repository: RubristRepository,
  projectId: string,
  skillVersionId: string
): Promise<void> {
  const version = await repository.getSkillVersion(projectId, skillVersionId);
  const criterionVersion = version
    ? await repository.getCriterionVersionForSkillVersion(projectId, skillVersionId)
    : null;
  let currentSkill = null;
  if (criterionVersion) {
    try {
      currentSkill = await repository.getCurrentSkillForCriterion(projectId, criterionVersion.criterionId);
    } catch (error) {
      if (!(error instanceof NoCurrentSkillError)) throw error;
    }
  }
  const starterDraft = currentSkill?.isStarter === true && version?.status === "draft";
  if (
    !version ||
    !currentSkill ||
    currentSkill.currentVersion.id !== version.id ||
    (!starterDraft && version.status !== "approved" && version.status !== "production")
  ) {
    throw new ImportSkillVersionBindingError(
      "Imported Runs can be evaluated only by the current runnable Check."
    );
  }
}

// Automatic imports evaluate only the supplied cases. Reuse coverage from an
// already saved backfill, but never create or expand historical work here.
// Every remaining case uses a durable unique run for this evaluator version.
export async function scheduleImportedCaseJudging(
  repository: RubristRepository,
  queue: Queue | undefined,
  input: { projectId: string; skillVersionId: string; caseIds: string[] }
): Promise<ImportedCaseJudgingResult> {
  await assertImportJudgingAllowed(repository, input.projectId, input.skillVersionId);
  const caseIds = [...new Set(input.caseIds)];
  if (caseIds.length === 0) {
    return {
      scheduledCaseCount: 0,
      evalRunIds: [],
      backfillRunId: null,
      dispatchPending: false
    };
  }

  const existingBackfill = (await repository.listEvalRuns(input.projectId, {
    limit: 1,
    purpose: "backfill",
    skillVersionId: input.skillVersionId
  })).find((run) => run.trigger === "backfill");

  let remaining = caseIds;
  let scheduledCaseCount = 0;
  let backfillRunId: string | null = null;
  let dispatchPending = false;
  const evalRunIds: string[] = [];
  if (existingBackfill) {
    const detail = await repository.getEvalRunDetail(input.projectId, existingBackfill.id);
    const covered = new Set(detail?.items.map((item) => item.caseId) ?? []);
    // Only resume a saved backfill when this import actually overlaps it.
    if (caseIds.some((caseId) => covered.has(caseId))) {
      backfillRunId = existingBackfill.id;
      evalRunIds.push(existingBackfill.id);
      dispatchPending = await dispatchEvalRunOnce(repository, existingBackfill, queue) === "busy";
      if (detail?.status === "pending" || detail?.status === "running") {
        scheduledCaseCount += caseIds.filter((caseId) => covered.has(caseId)).length;
      }
      remaining = caseIds.filter((caseId) => !covered.has(caseId));
    }
  }

  for (const caseId of remaining) {
    const [recorded] = await repository.listVerdicts({
      projectId: input.projectId,
      caseId,
      source: "llm_judge",
      skillVersionId: input.skillVersionId,
      evidenceScope: "customer",
      limit: 1
    });
    if (recorded) continue;
    const importedRun = await repository.createImportedCaseEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      caseId
    });
    const dispatchState = await dispatchEvalRunOnce(repository, importedRun.run, queue);
    evalRunIds.push(importedRun.run.id);
    if (importedRun.run.status === "pending" || importedRun.run.status === "running") {
      scheduledCaseCount += 1;
    }
    if (dispatchState === "busy") dispatchPending = true;
  }

  return {
    scheduledCaseCount,
    evalRunIds: [...new Set(evalRunIds)],
    backfillRunId,
    dispatchPending
  };
}
