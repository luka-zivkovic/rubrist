import type {SqliteValidatorReader} from './command-context.js';
import {evaluateGovernedCapability} from './governed-capability-commands.js';
import {createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {BinaryCalibrationCompletionEligibilityReason} from '@rubrist/shared';
import {canonicalJson,sha256Digest} from '../../lib/canonical-json.js';
import {governedContentV1Digest} from '../../lib/governed-content-digest.js';
import {COVERED_CAPABILITIES,isString,nullableString,repoError,stableId,toIso,type RunRow,type EligibilityResult} from '../../binary-calibration/storage-values.js';
// Native named SQLite parameters; all arrays are JSON TEXT, not PostgreSQL arrays.
function query(db:DatabaseSync,sql:string,values:unknown[]){
 const bindings=Object.fromEntries(values.map((value,index)=>{
  const v=Array.isArray(value)?JSON.stringify(value):value;
  if(v!==null&&typeof v!=='string'&&typeof v!=='number'&&typeof v!=='bigint'&&!(v instanceof Uint8Array))throw new Error('Invalid calibration SQL value');
  return ['$'+(index+1),v as SQLInputValue];
 }));
 const rows=db.prepare(sql).all(bindings);return {rows,rowCount:rows.length};
}
export function evaluateEligibility(
  client: DatabaseSync,
  run: RunRow,
  phase: "authorization" | "completion"
): EligibilityResult {
  const exposedSubjects = contentExposedSubjects(client, String(run.governed_review_batch_id));
  const capabilityChecks = appendFinalValidationChecks(client, run, phase, exposedSubjects);
  const exposureRows = query(client,
    `select id,kind,exposure_class,activity,subject_kind,subject_id,evidence_ref_kind,
            evidence_ref_id,occurred_at
     from dataset_exposure_events
     where revision_id=$1 and project_id=$2
       and not (evidence_ref_kind='binary_calibration_run' and evidence_ref_id=$3)
     order by occurred_at,id`,
    [run.dataset_revision_id, run.project_id, run.id]
  );
  const relevantExposures = exposureRows.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    exposureClass: String(row.exposure_class),
    activity: String(row.activity),
    subjectKind: String(row.subject_kind),
    subjectId: nullableString(row.subject_id),
    evidenceRefKind: nullableString(row.evidence_ref_kind),
    evidenceRefId: nullableString(row.evidence_ref_id),
    occurredAt: toIso(row.occurred_at)
  }));
  const exposureDetected = relevantExposures.some((event) =>
    event.exposureClass === "development" || [
      "declassify", "analysis_authoring", "rubric_authoring", "prompt_tuning",
      "example_selection", "model_selection", "development_run", "regression_run"
    ].includes(event.activity)
  );
  const reuse = evaluateEvaluatorReuse(client, run);
  const capabilitySemantic = capabilityChecks.map((check) => ({
    subjectId: check.subjectId,
    result: check.result,
    excludedCapabilities: check.excludedCapabilities,
    unknownCapabilities: check.unknownCapabilities
  }));
  const comparableFacts = {
    revisionDigest: String(run.revision_digest),
    criterionId: String(run.criterion_id),
    criterionVersionId: String(run.criterion_version_id),
    skillVersionId: String(run.skill_version_id),
    relevantExposures,
    capabilitySemantic,
    evaluatorReuse: reuse
  };
  const comparableFactsDigest = sha256Digest(comparableFacts);
  const reasons: BinaryCalibrationCompletionEligibilityReason[] = [];
  if (exposureDetected || capabilityChecks.some((check) => check.excludedCapabilities.length > 0)) {
    reasons.push("development_exposure_detected");
  }
  if (capabilityChecks.some((check) => check.result === "unknown")) {
    reasons.push("exposure_state_unknown");
  }
  if (!reuse.eligible) reasons.push("evaluator_reuse_ineligible");

  if (phase === "completion") {
    const authorization = query(client,
      `select canonical_bytes from binary_calibration_exposure_checks
       where id=$1 and run_id=$2 and phase='authorization'`,
      [run.authorization_check_id, run.id]
    );
    const raw = authorization.rows[0]?.canonical_bytes;
    if (!raw) {
      reasons.push("exposure_state_unknown");
    } else {
      const prior = JSON.parse(Buffer.from(raw as Uint8Array).toString("utf8")) as { comparableFactsDigest?: unknown };
      if (prior.comparableFactsDigest !== comparableFactsDigest) {
        reasons.push("authorization_snapshot_changed");
      }
    }
  }
  const sortedReasons = [...new Set(reasons)].sort() as BinaryCalibrationCompletionEligibilityReason[];
  const snapshot = {
    contract: "rubrist/binary-calibration-exposure-snapshot/v1",
    schemaVersion: 1,
    phase,
    calibrationRunId: run.id,
    projectId: run.project_id,
    datasetRevisionId: run.dataset_revision_id,
    revisionDigest: run.revision_digest,
    criterionId: run.criterion_id,
    criterionVersionId: run.criterion_version_id,
    skillVersionId: run.skill_version_id,
    comparableFactsDigest,
    comparableFacts,
    capabilityChecks,
    exposureState: exposureDetected ? "exposed" : "protected",
    eligibility: {
      result: sortedReasons.length === 0 ? "eligible" : "ineligible",
      reasons: sortedReasons
    }
  };
  return {
    exposureState: exposureDetected ? "exposed" : "protected",
    eligible: sortedReasons.length === 0,
    reasons: sortedReasons,
    snapshot
  };
}

function contentExposedSubjects(client: DatabaseSync, batchId: string): string[] {
  const result = query(client,
    `select custodian_subject_id as subject_id from governed_review_batches where id=$1
     union
     select reviewer_subject_id from governed_review_tasks where batch_id=$1
     union
     select adjudicator_subject_id from governed_review_adjudications where batch_id=$1`,
    [batchId]
  );
  return [...new Set(result.rows.map((row) => nullableString(row.subject_id)).filter(isString))].sort();
}

function appendFinalValidationChecks(
  client: DatabaseSync,
  run: RunRow,
  phase: "authorization" | "completion",
  subjectIds: string[]
) {
  const checks: Array<{
    checkId: string;
    contentDigest: string;
    subjectId: string;
    result: "eligible" | "ineligible" | "unknown";
    excludedCapabilities: string[];
    unknownCapabilities: string[];
  }> = [];
  for (const subjectId of subjectIds) {
    const evaluated = evaluateCalibrationCapability({get:(sql,...args)=>client.prepare(sql).get(...args),iterate:(sql,...args)=>client.prepare(sql).iterate(...args)},String(run.project_id),String(run.criterion_version_id),subjectId);
    const sequence = Number((query(client,
      `select coalesce(max(sequence),0) as sequence
       from governed_review_capability_checks
       where batch_id=$1 and check_scope='final_validation' and subject_id=$2
         and evaluator_version_id=$3`,
      [run.governed_review_batch_id, subjectId, run.skill_version_id]
    )).rows[0]?.sequence ?? 0) + 1;
    const evidence = {
      contract: "rubrist/sealed-separation-evidence/v1",
      criterionVersionId: run.criterion_version_id,
      evaluatedCapabilities: [...COVERED_CAPABILITIES],
      findings: evaluated.findings
    };
    const evidenceDigest = governedContentV1Digest("sealed-separation-evidence/v1", evidence);
    const content = {
      batchId: run.governed_review_batch_id,
      capabilityQueryVersion: "sealed-separation/v1",
      checkScope: "final_validation",
      coveredCapabilities: [...COVERED_CAPABILITIES],
      evidenceDigest,
      evaluatorVersionId: run.skill_version_id,
      excludedCapabilities: evaluated.excluded,
      result: evaluated.result,
      sequence,
      subjectId,
      unknownCapabilities: evaluated.unknown,
      verificationMethod: "system_derived"
    };
    const contentDigest = governedContentV1Digest("governed-review-capability-check/v1", content);
    const checkId = stableId("grcc", run.id, phase, subjectId);
    const idempotencyKey = `binary-calibration:${run.id}:${phase}:capability:${subjectId}`;
    const requestDigest = sha256Digest({ content, evidence });
    query(client,
      `insert into governed_review_capability_checks
         (id,project_id,batch_id,criterion_version_id,evaluator_version_id,subject_id,
          sequence,expected_previous_sequence,check_scope,result,verification_method,
          capability_query_version,covered_capabilities,excluded_capabilities,unknown_capabilities,
          evidence,evidence_digest,content_digest,idempotency_key,request_digest,checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'final_validation',$9,'system_derived',
               'sealed-separation/v1',$10,$11,$12,$13,$14,$15,$16,$17,
               sqlite_command_time())`,
      [checkId, run.project_id, run.governed_review_batch_id, run.criterion_version_id,
        run.skill_version_id, subjectId, sequence, sequence - 1, evaluated.result,
        [...COVERED_CAPABILITIES], evaluated.excluded, evaluated.unknown,
        JSON.stringify(evidence), evidenceDigest, contentDigest, idempotencyKey, requestDigest]
    );
    checks.push({
      checkId,
      contentDigest,
      subjectId,
      result: evaluated.result,
      excludedCapabilities: evaluated.excluded,
      unknownCapabilities: evaluated.unknown
    });
  }
  return checks.sort((left, right) => left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0);
}

export function evaluateCalibrationCapability(read:SqliteValidatorReader,projectId:string,criterionVersionId:string,subjectId:string){
 const result=evaluateGovernedCapability(read,projectId,criterionVersionId,subjectId),unknown=new Set(result.unknown);
 if(!result.findings.criterionAuthorKnown)unknown.add('criterion_author_identity');
 if(!result.findings.instructionAuthorKnown)unknown.add('instruction_author_identity');
 if(result.findings.evaluatorVersionsChecked===0)unknown.add('evaluator_author_identity');
 return {...result,unknown:[...unknown].sort(),result:result.excluded.length?'ineligible' as const:unknown.size?'unknown' as const:'eligible' as const};
}

function evaluateEvaluatorReuse(client: DatabaseSync, run: RunRow): Record<string, unknown> & { eligible: boolean } {
  const prior = query(client,
    `select id,skill_version_id,completed_at
     from binary_calibration_runs
     where dataset_revision_id=$1 and criterion_id=$2 and id<>$3
       and state in ('complete','incomplete') and completed_at is not null
     order by completed_at,id`,
    [run.dataset_revision_id, run.criterion_id, run.id]
  );
  if (prior.rows.length === 0) {
    return { eligible: true, basis: "first_final_validation", earliestPriorCompletedAt: null };
  }
  const earliest = toIso(prior.rows[0]!.completed_at);
  const hasDifferentVersion = prior.rows.some((row) => String(row.skill_version_id) !== String(run.skill_version_id));
  if (!hasDifferentVersion) {
    return { eligible: true, basis: "same_immutable_evaluator_version", earliestPriorCompletedAt: earliest };
  }
  const version = (query(client,
    `select created_at,developer_identity_status from skill_versions where id=$1 and project_id=$2`,
    [run.skill_version_id, run.project_id]
  )).rows[0];
  const development = query(client,
    `select occurred_at from governed_evaluator_development_events
     where skill_version_id=$1 and project_id=$2 order by occurred_at,id`,
    [run.skill_version_id, run.project_id]
  );
  const timestampsKnown = Boolean(version) && version?.developer_identity_status === "recorded" && development.rows.length > 0;
  const createdBefore = timestampsKnown && toIso(version?.created_at) < earliest;
  const allDevelopmentBefore = timestampsKnown && development.rows.every((row) => toIso(row.occurred_at) < earliest);
  return {
    eligible: Boolean(createdBefore && allDevelopmentBefore),
    basis: "different_evaluator_version_pretest_only",
    earliestPriorCompletedAt: earliest,
    evaluatorCreatedAt: version ? toIso(version.created_at) : null,
    developmentEventCount: development.rows.length,
    allDevelopmentBeforeEarliestCompletion: Boolean(allDevelopmentBefore)
  };
}

export function snapshotRecord(
  run: RunRow,
  phase: "authorization" | "completion",
  exposureState: "protected" | "exposed",
  eligibility: "eligible" | "ineligible",
  reasons: BinaryCalibrationCompletionEligibilityReason[],
  snapshot: Record<string, unknown>,
  recordedAt: string
) {
  const canonicalBytes = Buffer.from(canonicalJson(snapshot), "utf8");
  return {
    id: stableId("bcec", run.id, phase),
    runId: run.id,
    projectId: run.project_id,
    phase,
    exposureState,
    eligibility,
    reasons,
    canonicalBytes,
    snapshotDigest: `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`,
    recordedAt
  };
}

