import { ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION, ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION, type AnalysisCriterionPromotionSummary, type AnalysisCriterionPromotionArtifact, type AnalysisCriterionPromotionSupportArtifact, type AnalysisCriterionPromotionCandidate, type AnalysisCriterionPromotionHandoff, type Criterion, type CriterionVersion } from '@rubrist/shared';
import { AnalysisPromotionRepositoryError } from './repository.js';
const repoError=(code:ConstructorParameters<typeof AnalysisPromotionRepositoryError>[0],message:string)=>new AnalysisPromotionRepositoryError(code,message);
export function rowToSummary(row: Record<string, unknown>): AnalysisCriterionPromotionSummary {
  const promotion = rowToPromotion(row);
  const criterion: Criterion = {
    id: promotion.criterionId,
    projectId: promotion.projectId,
    stableKey: String(row.criterion_stable_key_row),
    sourceKind: sourceKind(row.criterion_source_kind),
    createdByUserId: nullableString(row.criterion_created_by_user_id),
    createdAt: iso(row.criterion_created_at)
  };
  const criterionVersion: CriterionVersion = {
    id: promotion.criterionVersionId,
    projectId: promotion.projectId,
    criterionId: promotion.criterionId,
    revision: Number(row.criterion_version_revision),
    name: String(row.criterion_version_name),
    definition: String(row.criterion_version_definition),
    criterionDigest: String(row.criterion_version_digest),
    sourceKind: sourceKind(row.criterion_version_source_kind),
    createdByUserId: nullableString(row.criterion_version_created_by_user_id),
    createdAt: iso(row.criterion_version_created_at)
  };
  const handoff: AnalysisCriterionPromotionHandoff = {
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    promotionId: promotion.id,
    projectId: promotion.projectId,
    criterionId: promotion.criterionId,
    criterionVersionId: promotion.criterionVersionId,
    criterionDigest: promotion.criterionDigest,
    sourceDatasetRevisionId: promotion.sourceDatasetRevisionId,
    sourceDatasetRevisionContentDigest: promotion.sourceDatasetRevisionContentDigest,
    sourceDatasetRevisionDigest: promotion.sourceDatasetRevisionDigest,
    roleIntent: "analysis_authoring",
    sourceKind: "analysis_promotion_handoff",
    evidenceClass: "development_authoring_not_truth",
    createsTruth: false,
    createsEvaluator: false,
    handoffDigest: promotion.handoffDigest
  };
  return { promotion, criterion, criterionVersion, handoff };
}

export function rowToPromotion(row: Record<string, unknown>): AnalysisCriterionPromotionArtifact {
  return {
    id: String(row.promotion_id ?? row.id), projectId: String(row.project_id),
    contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
    studyId: String(row.study_id), studyClosureId: String(row.study_closure_id),
    studyClosureDigest: String(row.study_closure_digest), populationId: String(row.population_id),
    drawId: String(row.draw_id), sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionContentDigest: String(row.source_dataset_revision_content_digest),
    sourceDatasetRevisionDigest: String(row.source_dataset_revision_digest), taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: String(row.taxonomy_revision_id), taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    taxonomyRevisionDigest: String(row.taxonomy_revision_digest), codeId: String(row.code_id),
    codeEntryId: String(row.code_entry_id), codeEntryDigest: String(row.code_entry_digest),
    codeLabel: String(row.code_label), codeDefinition: String(row.code_definition),
    criterionId: String(row.criterion_id), criterionVersionId: String(row.criterion_version_id),
    criterionStableKey: String(row.criterion_stable_key), criterionName: String(row.criterion_name),
    criterionDefinition: String(row.criterion_definition), criterionDigest: String(row.criterion_digest),
    rationale: String(row.rationale), supportCount: Number(row.support_count),
    supportSetDigest: String(row.support_set_digest),
    criterionAuthoringExposureEventId: String(row.criterion_authoring_exposure_event_id),
    promotedByUserId: String(row.promoted_by_user_id), promotedBySubjectId: String(row.promoted_by_subject_id),
    promoterRole: "owner", idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest), handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    handoffDigest: String(row.handoff_digest), createdAt: iso(row.created_at)
  };
}

export function rowToSupport(row: Record<string, unknown>): AnalysisCriterionPromotionSupportArtifact {
  return {
    id: String(row.id), projectId: String(row.project_id), promotionId: String(row.promotion_id),
    position: Number(row.position), studyId: String(row.study_id), studyItemId: String(row.study_item_id),
    closureId: String(row.closure_id), closureItemId: String(row.closure_item_id),
    closureItemDigest: String(row.closure_item_digest),
    sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionItemId: String(row.source_dataset_revision_item_id),
    sourceItemDigest: String(row.source_item_digest), observationEventId: String(row.observation_event_id),
    observationEventDigest: String(row.observation_event_digest), assignmentEventId: String(row.assignment_event_id),
    assignmentEventDigest: String(row.assignment_event_digest),
    observationAuthorSubjectId: String(row.observation_author_subject_id),
    exampleSelectionExposureEventId: String(row.example_selection_exposure_event_id),
    contentDigest: String(row.content_digest), createdAt: iso(row.created_at)
  };
}

export function rowToCandidate(row: Record<string, unknown>): AnalysisCriterionPromotionCandidate {
  return {
    projectId: String(row.project_id), studyId: String(row.study_id),
    studyState: String(row.study_state) as "coding_closed" | "completed",
    closureId: String(row.closure_id), closureDigest: String(row.closure_digest),
    taxonomyId: String(row.taxonomy_id), taxonomyRevisionId: String(row.taxonomy_revision_id),
    taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    taxonomyRevisionDigest: String(row.taxonomy_revision_digest), codeId: String(row.code_id),
    codeEntryId: String(row.code_entry_id), codeEntryDigest: String(row.code_entry_digest),
    codeLabel: String(row.code_label), codeDefinition: String(row.code_definition), codeStatus: "active",
    studyItemId: String(row.study_item_id), closureItemId: String(row.closure_item_id),
    closureItemDigest: String(row.closure_item_digest), position: Number(row.position),
    sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionItemId: String(row.source_dataset_revision_item_id),
    sourceItemDigest: String(row.source_item_digest), observationEventId: String(row.observation_event_id),
    observationEventDigest: String(row.observation_event_digest), failureLabel: String(row.failure_label),
    observationRationale: String(row.observation_rationale),
    evidenceAnchor: String(row.anchor_kind) === "step"
      ? { kind: "step", stepIndex: Number(row.anchor_step_index) }
      : { kind: "case_output" },
    assignmentEventId: String(row.assignment_event_id), assignmentEventDigest: String(row.assignment_event_digest),
    assignmentRationale: String(row.assignment_rationale),
    observationAuthorSubjectId: String(row.observation_author_subject_id)
  };
}

function sourceKind(value: unknown): "native" | "analysis_promotion" {
  if (value === "native" || value === "analysis_promotion") return value;
  throw new Error(`Unsupported criterion source kind: ${String(value)}`);
}

export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeTimestampCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (cursor === null) return null;
  const value = decodeCursor(cursor);
  if (value.kind !== "promotion" || typeof value.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt) ||
    typeof value.id !== "string" || value.id.length < 1 || value.id.length > 240) {
    throw repoError("analysis_promotion_invalid_cursor", "Invalid analysis promotion cursor");
  }
  return { createdAt: value.createdAt, id: value.id };
}

export function decodePositionCursor(
  cursor: string | null,
  kind: "candidate" | "support"
): { position: number; id: string } | null {
  if (cursor === null) return null;
  const value = decodeCursor(cursor);
  if (value.kind !== kind || !Number.isInteger(value.position) || Number(value.position) < 0 ||
    Number(value.position) > 9_999 || typeof value.id !== "string" ||
    value.id.length < 1 || value.id.length > 240) {
    throw repoError("analysis_promotion_invalid_cursor", "Invalid analysis promotion cursor");
  }
  return { position: Number(value.position), id: value.id };
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value as Record<string, unknown>).some((key) => !["v", "kind", "createdAt", "position", "id"].includes(key)) ||
      (value as { v?: unknown }).v !== 1) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw repoError("analysis_promotion_invalid_cursor", "Invalid analysis promotion cursor");
  }
}
