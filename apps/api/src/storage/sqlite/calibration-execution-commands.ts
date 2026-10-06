import {authorizeLifecycleExecution} from './lifecycle-authorization.js';
import {EvaluatorLifecycleRepositoryError} from '../../evaluator-lifecycle/repository.js';
import {GovernedReviewNotFoundError} from '../../governed-review/errors.js';
import {randomBytes} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {type EvaluatorIdentity} from '@rubrist/shared';
import {BinaryCalibrationRepositoryError,type BinaryCalibrationExecutionClaim,type BinaryCalibrationAuthorizedRun,type CompleteBinaryCalibrationAttemptInput} from '../../binary-calibration/repository.js';
import {stableId,repoError,validateAttemptCompletion,attemptColumnsFor,type RunRow} from '../../binary-calibration/storage-values.js';
import {canonicalJson,sha256Digest} from '../../lib/canonical-json.js';
import {evaluatorIdentityFor,skillDigestInput} from '../../lib/evaluator-identity.js';
import {sqliteSkillVersion} from './definition-commands.js';
import {sqliteCommand,type SqliteCommandContext} from './command-context.js';
import {requireCalibrationClaim} from './calibration-claim-commands.js';
import {evaluateEligibility,snapshotRecord} from './calibration-eligibility.js';
import {initializeCalibrationValidator} from './calibration-validator.js';
import {initializeGovernedCapabilityValidator} from './governed-capability-commands.js';
function insert(c:SqliteCommandContext,table:string,row:Record<string,SQLInputValue>){c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));}
function lease(c:SqliteCommandContext,run:RunRow){if(!c.db.prepare('SELECT 1 FROM binary_calibration_revision_leases WHERE run_id=? AND dataset_revision_id=?').get(run.id,run.dataset_revision_id))throw repoError('state_conflict','binary calibration revision lease is missing');}
function pinned(c:SqliteCommandContext,run:RunRow){
 const row=c.db.prepare('SELECT * FROM skill_versions WHERE id=? AND project_id=?').get(run.skill_version_id,run.project_id);if(!row)return null;
 try{const version=sqliteSkillVersion(row),identity=evaluatorIdentityFor(version);if(canonicalJson(identity.executionBinding)!==canonicalJson(JSON.parse(String(run.execution_binding)))||sha256Digest(identity.executionBinding)!==run.requested_binding_digest||skillDigestInput(identity).definitionDigest!==run.definition_digest)return null;return {version,identity};}catch{return null;}
}
/** PostgreSQL maps every lifecycle refusal of this exact authorization to `ineligible`; so does SQLite. */
const lifecycleRefusals={execution_forbidden:'binary calibration identity or invariant is ineligible',not_found:'binary calibration evaluator version is unavailable',idempotency_conflict:'binary calibration execution authorization replay does not match'} as Record<string,string>;
export function authorizeCalibrationLifecycle(c:SqliteCommandContext,run:RunRow){
 try{authorizeLifecycleExecution(c,{projectId:run.project_id,skillVersionId:run.skill_version_id,context:'binary_calibration_evidence',resourceKind:'binary_calibration_run',resourceId:run.id,idempotencyKey:`provider-start:binary-calibration:${run.id}:${run.skill_version_id}`},stableId('eauth',run.id,'binary_calibration_evidence'));}
 catch(error){if(error instanceof EvaluatorLifecycleRepositoryError)throw repoError('ineligible',lifecycleRefusals[error.code]??'binary calibration identity or invariant is ineligible');throw error;}
}
function authorized(c:SqliteCommandContext,claim:BinaryCalibrationExecutionClaim):BinaryCalibrationAuthorizedRun{
 const run=requireCalibrationClaim(c,claim);lease(c,run);const pin=pinned(c,run);if(!pin)throw repoError('state_conflict','binary calibration evaluator version no longer holds the identity its run pinned');
 const check=c.db.prepare("SELECT * FROM binary_calibration_exposure_checks WHERE id=? AND run_id=? AND phase='authorization'").get(String(run.authorization_check_id),run.id);if(!check)throw repoError('state_conflict','binary calibration authorization claim is stale');
 const v=pin.version;
 return {claim:{...claim,claimExpiresAt:String(run.claim_expires_at)},projectId:run.project_id,datasetRevisionId:run.dataset_revision_id,revisionDigest:run.revision_digest,itemCount:run.item_count,skillVersionId:run.skill_version_id,executionBinding:pin.identity.executionBinding,customEndpointUrl:v.customEndpointUrl,providerDataHandling:{executionEnvironment:run.execution_environment as BinaryCalibrationAuthorizedRun['providerDataHandling']['executionEnvironment'],policyId:String(run.provider_policy_id),policyDigest:String(run.provider_policy_digest),payloadTransmission:'sealed_payload_to_pinned_provider'},evaluator:v.typedQuestion!==null&&v.decisionThreshold!==null?{kind:'typed-question',question:v.typedQuestion,threshold:v.decisionThreshold}:{kind:'prompted',rubricMarkdown:v.rubricMarkdown!,prompt:v.prompt!},authorization:{snapshotDigest:String(check.snapshot_digest),eventId:String(check.id),recordedAt:String(check.recorded_at)}};
}
export function sqliteCalibrationExecutionCommands(db:DatabaseSync,clock=Date.now){
 initializeGovernedCapabilityValidator(db);initializeCalibrationValidator(db);
 return {
  authorizeRun(claim:BinaryCalibrationExecutionClaim):BinaryCalibrationAuthorizedRun{
   let result:BinaryCalibrationAuthorizedRun|BinaryCalibrationRepositoryError;
   try{result=sqliteCommand(db,c=>{
    const run=requireCalibrationClaim(c,claim);
    authorizeCalibrationLifecycle(c,run);
    if(run.authorization_check_id)return authorized(c,claim);
    const reject=(reason:string)=>{c.db.prepare("UPDATE binary_calibration_runs SET state='rejected',rejection_reason=?,completed_at=?,claim_worker_id=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=?").run(reason,c.timestamp,run.id);return repoError('ineligible','sealed calibration authorization was rejected');};
    if(!pinned(c,run))return reject('evaluator_version_changed');
    const eligibility=evaluateEligibility(db,run,'authorization');
    if(!eligibility.eligible||eligibility.exposureState!=='protected')return reject(eligibility.reasons.join(',')||'exposure_state_unknown');
    try{insert(c,'binary_calibration_revision_leases',{dataset_revision_id:run.dataset_revision_id,project_id:run.project_id,run_id:run.id,acquired_at:c.timestamp});}catch(error){if(((Number((error as {errcode?:number}).errcode)||0)&255)===19)throw repoError('state_conflict','binary calibration revision is already leased');throw error;}
    const eventId=stableId('bcde',run.id,'authorization');
    insert(c,'dataset_exposure_events',{id:eventId,project_id:run.project_id,revision_id:run.dataset_revision_id,kind:'evaluator_execution',exposure_class:'provenance',activity:'final_validation_run',subject_kind:'evaluator_version',subject_id:run.skill_version_id,evidence_ref_kind:'binary_calibration_run',evidence_ref_id:run.id,reason:'Sealed binary calibration authorization',details:JSON.stringify({calibrationRunId:run.id,criterionVersionId:run.criterion_version_id}),idempotency_key:`binary-calibration:${run.id}:authorization`,occurred_at:c.timestamp});
    const check=snapshotRecord(run,'authorization','protected','eligible',[],{...eligibility.snapshot,authorizationExposureEventId:eventId,recordedAt:c.timestamp},c.timestamp);
    insert(c,'binary_calibration_exposure_checks',{id:check.id,run_id:run.id,project_id:run.project_id,phase:check.phase,exposure_state:check.exposureState,eligibility_result:check.eligibility,eligibility_reasons:JSON.stringify(check.reasons),canonical_bytes:check.canonicalBytes,snapshot_digest:check.snapshotDigest,recorded_at:c.timestamp});
    const truth=c.db.prepare("SELECT i.id,i.item_digest,t.resolved_label FROM dataset_revision_items i JOIN governed_dataset_truth_links t ON t.dataset_revision_item_id=i.id AND t.dataset_revision_id=i.revision_id AND t.criterion_version_id=? WHERE i.revision_id=? AND i.project_id=? AND t.source_kind IN('governed_labels','adjudication') ORDER BY i.item_digest,i.id").all(run.criterion_version_id,run.dataset_revision_id,run.project_id);
    if(truth.length!==run.item_count)throw repoError('ineligible','sealed revision does not have exact governed binary truth coverage');
    for(const item of truth)insert(c,'binary_calibration_attempts',{id:stableId('bca',run.id,String(item.item_digest)),run_id:run.id,project_id:run.project_id,dataset_revision_item_id:item.id!,dataset_revision_item_digest:item.item_digest!,trial_index:0,truth_label:item.resolved_label!,provider:run.requested_provider,commitment_salt:randomBytes(32).toString('hex'),created_at:c.timestamp});
    c.db.prepare('UPDATE binary_calibration_runs SET authorization_check_id=?,started_at=? WHERE id=?').run(check.id,c.timestamp,run.id);
    insert(c,'binary_calibration_authorization_finalizations',{run_id:run.id,project_id:run.project_id,command_token:c.token});
    return authorized(c,claim);
   },clock);}catch(error){if(error instanceof GovernedReviewNotFoundError)throw repoError('ineligible','content-exposed subject is outside the calibration project');throw error;}
   // Rejection evidence must commit before the typed failure reaches the caller.
   if(result instanceof BinaryCalibrationRepositoryError)throw result;return result;
  },
  getNextAttempt(claim:BinaryCalibrationExecutionClaim){return sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim);const row=c.db.prepare("SELECT a.*,i.payload_snapshot FROM binary_calibration_attempts a JOIN dataset_revision_items i ON i.id=a.dataset_revision_item_id JOIN binary_calibration_revision_leases l ON l.run_id=a.run_id AND l.dataset_revision_id=i.revision_id WHERE a.run_id=? AND a.accounting_state='pending' AND a.attempt_state='not_started' ORDER BY a.trial_index,a.dataset_revision_item_digest LIMIT 1").get(run.id);return row?{attemptId:String(row.id),runId:String(row.run_id),datasetRevisionItemDigest:String(row.dataset_revision_item_digest),trialIndex:0 as const,payloadSnapshot:JSON.parse(String(row.payload_snapshot)),physicalProviderCalls:Number(row.physical_provider_calls)}:null;},clock);},
  recordProviderCallStarted(claim:BinaryCalibrationExecutionClaim,attemptId:string){return sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim);lease(c,run);const row=c.db.prepare("UPDATE binary_calibration_attempts SET attempt_state='started',physical_provider_calls=physical_provider_calls+1 WHERE id=? AND run_id=? AND accounting_state='pending' AND physical_provider_calls<9007199254740991 RETURNING physical_provider_calls").get(attemptId,run.id);if(!row)throw repoError('state_conflict','binary calibration attempt cannot start a provider call');return Number(row.physical_provider_calls);},clock);},
  completeAttempt(claim:BinaryCalibrationExecutionClaim,attemptId:string,input:CompleteBinaryCalibrationAttemptInput){validateAttemptCompletion(input);sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim);lease(c,run);if(input.providerObservation.provider!==run.requested_provider)throw repoError('conflict','attempt provider observation does not match the pinned requested provider');const columns=attemptColumnsFor(input.result),observation=input.providerObservation;
   const result=c.db.prepare("UPDATE binary_calibration_attempts SET accounting_state='accounted',terminal_evaluator_outcome=?,attempt_state=?,error_code=?,observed_model=?,observed_version=?,system_fingerprint=?,upstream_provider=?,accounted_at=? WHERE id=? AND run_id=? AND accounting_state='pending'").run(columns.terminalEvaluatorOutcome,input.attemptState,columns.errorCode,observation.observedModel,observation.observedVersion,observation.systemFingerprint,observation.upstreamProvider,c.timestamp,attemptId,run.id);
   if(!result.changes)throw repoError('state_conflict','binary calibration attempt is already accounted or missing');c.db.prepare('UPDATE binary_calibration_runs SET accounted_observations=accounted_observations+1 WHERE id=?').run(run.id);
  },clock);},
  recoverStartedAttempts(claim:BinaryCalibrationExecutionClaim){return sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim);lease(c,run);const result=c.db.prepare("UPDATE binary_calibration_attempts SET accounting_state='accounted',terminal_evaluator_outcome='errored',attempt_state='started',error_code='outcome_unknown',accounted_at=? WHERE run_id=? AND accounting_state='pending' AND attempt_state='started'").run(c.timestamp,run.id);if(result.changes)c.db.prepare('UPDATE binary_calibration_runs SET accounted_observations=accounted_observations+? WHERE id=?').run(Number(result.changes),run.id);return Number(result.changes);},clock);}
 };
}
