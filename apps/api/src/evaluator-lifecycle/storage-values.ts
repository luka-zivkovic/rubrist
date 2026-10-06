import {EVALUATOR_LIFECYCLE_CONTRACT_VERSION,EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,EvaluatorLifecycleEventSchema,MUTABLE_MODEL_ALIAS_RULE_VERSION,mutableModelAlias,type EvaluatorLifecycleArtifact,type EvaluatorLifecycleEvent,type ExecutionBinding,type ResolutionRecord} from '@rubrist/shared';
import {governedGateRefusal} from '../lib/binding-resolution.js';
import {EvaluatorLifecycleRepositoryError,type EvaluatorLifecycleAccess} from './repository.js';
export function rowToLifecycle(row: Record<string, unknown>): EvaluatorLifecycleArtifact {
  return {
    id: String(row.id),
    contractVersion: EVALUATOR_LIFECYCLE_CONTRACT_VERSION,
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    skillId: String(row.skill_id),
    skillVersionId: String(row.skill_version_id),
    promotionId: String(row.promotion_id),
    governedBatchId: String(row.governed_batch_id),
    governedBatchDigest: String(row.governed_batch_digest),
    truthDatasetRevisionId: String(row.truth_dataset_revision_id),
    truthRevisionDigest: String(row.truth_revision_digest),
    truthContentDigest: String(row.truth_content_digest),
    truthItemCount: Number(row.truth_item_count),
    regressionDatasetRevisionId: String(row.regression_dataset_revision_id),
    regressionRevisionDigest: String(row.regression_revision_digest),
    regressionContentDigest: String(row.regression_content_digest),
    regressionItemCount: Number(row.regression_item_count),
    developerExposureEventId: String(row.developer_exposure_event_id),
    createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest),
    createdAt: toIso(row.created_at)
  };
}

export function rowToEvent(row: Record<string, unknown>): EvaluatorLifecycleEvent {
  return EvaluatorLifecycleEventSchema.parse({
    id: String(row.id),
    contractVersion: EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,
    lifecycleId: String(row.lifecycle_id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    skillVersionId: String(row.skill_version_id),
    sequence: String(row.sequence),
    transition: row.transition,
    state: row.state,
    predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest),
    activationBundleId: nullableString(row.activation_bundle_id),
    activationEvidence: row.calibration_artifact_id ? {
      calibrationArtifactId: String(row.calibration_artifact_id),
      calibrationArtifactDigest: String(row.calibration_artifact_digest),
      calibrationEvidenceDigest: String(row.calibration_evidence_digest),
      regressionRunId: String(row.regression_run_id),
      regressionDatasetRevisionId: String(row.regression_dataset_revision_id)
    } : null,
    replacedSkillVersionId: nullableString(row.replaced_skill_version_id),
    actorUserId: nullableString(row.actor_user_id),
    actorSubjectId: nullableString(row.actor_subject_id),
    actorRole: row.actor_role,
    reason: String(row.reason),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest),
    occurredAt: toIso(row.occurred_at)
  });
}

export function rowToEventFromProjection(row: Record<string, unknown>): EvaluatorLifecycleEvent {
  return rowToEvent({
    id: row.event_id,
    contract_version: row.event_contract_version,
    lifecycle_id: row.id,
    project_id: row.project_id,
    criterion_id: row.criterion_id,
    skill_version_id: row.skill_version_id,
    sequence: row.event_sequence,
    transition: row.transition,
    state: row.state,
    predecessor_event_id: row.predecessor_event_id,
    predecessor_event_digest: row.predecessor_event_digest,
    activation_bundle_id: row.activation_bundle_id,
    calibration_artifact_id: row.calibration_artifact_id,
    calibration_artifact_digest: row.calibration_artifact_digest,
    calibration_evidence_digest: row.calibration_evidence_digest,
    regression_run_id: row.regression_run_id,
    regression_dataset_revision_id: row.event_regression_revision_id,
    replaced_skill_version_id: row.replaced_skill_version_id,
    actor_user_id: row.actor_user_id,
    actor_subject_id: row.actor_subject_id,
    actor_role: row.actor_role,
    reason: row.event_reason,
    idempotency_key: row.event_idempotency_key,
    request_digest: row.event_request_digest,
    content_digest: row.event_content_digest,
    occurred_at: row.event_occurred_at
  });
}


export function requireOwner(actor: EvaluatorLifecycleAccess): void {
  if (actor.projectRole !== "owner") throw repoError("forbidden", "Only project owners may change evaluator lifecycle");
}

export function repoError(code: ConstructorParameters<typeof EvaluatorLifecycleRepositoryError>[0], message: string): EvaluatorLifecycleRepositoryError {
  return new EvaluatorLifecycleRepositoryError(code, message);
}

export function rejectMutableModelAlias(modelId: string, gate: string): void {
  const alias = mutableModelAlias(modelId);
  if (alias === null) return;
  throw new EvaluatorLifecycleRepositoryError(
    "mutable_model_alias",
    `An evaluator bound to the mutable model alias "${modelId}" cannot ${gate}; pin a specific model id`,
    { modelId, alias, rule: MUTABLE_MODEL_ALIAS_RULE_VERSION }
  );
}

/** The governed gate (ADR-0014 section 2): a resolved binding stating its temperature and reasoning. */
export function rejectUngovernedBinding(binding: ExecutionBinding, record: ResolutionRecord | null): void {
  const refusal = governedGateRefusal(binding, record);
  if (refusal === null) return;
  throw new EvaluatorLifecycleRepositoryError("execution_binding_unresolved", refusal.message, {
    problems: refusal.problems.join("; "),
    providerMessage: refusal.providerMessage,
    suggestion: refusal.suggestion
  });
}


export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  return value;
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

interface LifecycleCursor {
  createdAt: string;
  id: string;
}

export function encodeLifecycleCursor(cursor: LifecycleCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeLifecycleCursor(value: string): LifecycleCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.createdAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.createdAt) ||
        !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" ||
        parsed.id.length < 1 || parsed.id.length > 240 || Object.keys(parsed).length !== 3) {
      throw new Error("invalid lifecycle cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw repoError("invalid_cursor", "Invalid evaluator lifecycle cursor");
  }
}
