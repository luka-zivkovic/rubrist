import type {Pool,PoolClient} from 'pg';
import {EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,SkillVersionSchema,type SkillVersion} from '@rubrist/shared';
import {evaluatorExecutionAuthorizationDigest} from '../lib/evaluator-lifecycle.js';
import {rowToEvaluatorDefinitionText} from '../repository.pg/mappers.js';
import {BinaryCalibrationRepositoryError,type BinaryCalibrationActor} from './repository.js';
import {asStringArray,nullableString,parseJson,repoError,stableId,toIso} from './storage-values.js';
export { aggregateTrial,artifactCopyFromRow,asStringArray,attemptColumnsFor,attemptResultFromRow,claimFromRow,isEmptyObject,isString,nullableString,parseJson,providerPolicyFor,repoError,requireOwner,rowToRun,stableId,toIso,validateAttemptCompletion,validateClaimInput,validateCreateInput,COVERED_CAPABILITIES } from "./storage-values.js";
export type {RunRow,FrozenOriginRow,EligibilityResult} from "./storage-values.js";

export type Db = Pool | PoolClient;

export function skillVersionFromRow(row: Record<string, unknown>): SkillVersion {
  const scalarRange = row.scalar_range === null || row.scalar_range === undefined
    ? null : parseJson(row.scalar_range);
  const choices = row.categorical_choice_scores === null || row.categorical_choice_scores === undefined
    ? null : parseJson(row.categorical_choice_scores);
  return SkillVersionSchema.parse({
    id: String(row.id),
    skillId: String(row.skill_id),
    criterionVersionId: String(row.criterion_version_id),
    version: String(row.version),
    status: String(row.status),
    ...rowToEvaluatorDefinitionText(row),
    executionBinding: parseJson(row.execution_binding),
    customEndpointUrl: row.custom_endpoint_url == null ? null : String(row.custom_endpoint_url),
    outputSchema: parseJson(row.output_schema),
    goldenSetAgreement: row.golden_set_agreement == null ? null : Number(row.golden_set_agreement),
    tooStrictCount: Number(row.too_strict_count),
    tooLenientCount: Number(row.too_lenient_count),
    ambiguousCount: Number(row.ambiguous_count),
    knownLimitations: asStringArray(row.known_limitations),
    verdictKind: String(row.verdict_kind),
    scalarRange,
    categoricalChoiceScores: choices,
    rubricProvenance: String(row.rubric_provenance),
    rubricProvenanceDeclared: row.rubric_provenance_declared === true,
    regressionDatasetRevisionId: nullableString(row.regression_dataset_revision_id),
    createdAt: toIso(row.created_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null
  });
}

export async function requireProjectOwner(client: PoolClient, actor: BinaryCalibrationActor): Promise<void> {
  const result = await client.query(
    `select 1 from project_members where project_id=$1 and user_id=$2 and role='owner'`,
    [actor.projectId, actor.userId]
  );
  if (!result.rows[0]) throw repoError("forbidden", "only a project owner may start sealed calibration");
}

export function mapPgError(error: unknown): Error {
  if (error instanceof BinaryCalibrationRepositoryError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint) : "";
  if (code === "23505" && constraint.includes("idempotency")) {
    return repoError("idempotency_conflict", "binary calibration idempotency conflict");
  }
  if (code === "23505" || code === "40001" || code === "40P01" || code === "55000") {
    return repoError("state_conflict", "binary calibration state conflict");
  }
  if (code === "23503" || code === "23514") {
    return repoError("ineligible", "binary calibration identity or invariant is ineligible");
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function insertEvaluatorExecutionAuthorization(
  client: PoolClient,
  run: Record<string, unknown>,
  input: {
    context: "binary_calibration_evidence";
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }
): Promise<void> {
  const current = (await client.query(
    `select lifecycle.id as lifecycle_id,head.id as event_id,head.calibration_artifact_id
     from skill_versions version
     left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
     left join lateral evaluator_lifecycle_head_v1(lifecycle.id) head on true
     where version.project_id=$1 and version.id=$2`,
    [run.project_id, run.skill_version_id]
  )).rows[0];
  if (!current) throw repoError("ineligible", "binary calibration evaluator version is unavailable");
  const contentDigest = evaluatorExecutionAuthorizationDigest({
    projectId: String(run.project_id),
    skillVersionId: String(run.skill_version_id),
    context: input.context,
    lifecycleEventId: current.event_id ? String(current.event_id) : null,
    calibrationArtifactId: current.calibration_artifact_id ? String(current.calibration_artifact_id) : null,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId
  });
  const authorization = await client.query(
    `insert into evaluator_execution_authorizations
       (id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,
        calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (project_id,idempotency_key)
     do nothing
     returning content_digest`,
    [stableId("eauth",String(run.id),input.context),EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
      run.project_id,run.skill_version_id,input.context,current.event_id ?? null,
      current.calibration_artifact_id ?? null,input.resourceKind,input.resourceId,input.idempotencyKey,
      contentDigest]
  );
  const persistedDigest = authorization.rows[0]?.content_digest ?? (await client.query(
    `select content_digest from evaluator_execution_authorizations
     where project_id=$1 and idempotency_key=$2`,
    [run.project_id,input.idempotencyKey]
  )).rows[0]?.content_digest;
  if (String(persistedDigest ?? "") !== contentDigest) {
    throw repoError("ineligible", "binary calibration execution authorization replay does not match");
  }
}

export async function databaseClock(db: Db): Promise<string> {
  const row = (await db.query(
    `select date_trunc('milliseconds',clock_timestamp()) as recorded_at`
  )).rows[0];
  return toIso(row.recorded_at);
}
