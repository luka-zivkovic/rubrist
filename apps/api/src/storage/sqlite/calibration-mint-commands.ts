import {initializeCalibrationMintValidator} from './calibration-mint-validator.js';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {BinaryCalibrationRepositoryError,type BinaryCalibrationExecutionClaim,type BinaryCalibrationMintResult,type BinaryCalibrationProjectAccess,type BinaryCalibrationArtifactStatusProjection,type BinaryCalibrationArtifactStatusReason} from '../../binary-calibration/repository.js';
import {repoError,rowToRun,artifactCopyFromRow,type RunRow} from '../../binary-calibration/storage-values.js';
import {BINARY_CALIBRATION_CONTRACT,BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT} from '../../lib/binary-calibration.js';
import {sqliteCommand,type SqliteCommandContext} from './command-context.js';
import {requireCalibrationClaim} from './calibration-claim-commands.js';
import {authorizeCalibrationLifecycle} from './calibration-execution-commands.js';
import {evaluateEligibility,snapshotRecord} from './calibration-eligibility.js';
import {calibrationEvidence} from './calibration-evidence.js';
import {initializeCalibrationValidator} from './calibration-validator.js';
import {initializeGovernedCapabilityValidator} from './governed-capability-commands.js';
function insert(c:SqliteCommandContext,table:string,row:Record<string,SQLInputValue>){return c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')}) RETURNING *`).get(...Object.values(row))!;}
function mint(db:DatabaseSync,c:SqliteCommandContext,run:RunRow):BinaryCalibrationMintResult{
 if(!c.db.prepare('SELECT 1 FROM binary_calibration_revision_leases WHERE run_id=? AND dataset_revision_id=?').get(run.id,run.dataset_revision_id))throw repoError('state_conflict','binary calibration revision lease is missing');
 if(!run.authorization_check_id||!run.started_at)throw repoError('state_conflict','binary calibration run is not authorized');
 if(c.db.prepare("SELECT 1 FROM binary_calibration_attempts WHERE run_id=? AND accounting_state='pending' LIMIT 1").get(run.id)||run.accounted_observations!==run.planned_observations)throw repoError('state_conflict','binary calibration run still has unaccounted observations');
 const completion=evaluateEligibility(db,run,'completion'),check=snapshotRecord(run,'completion',completion.exposureState,completion.eligible?'eligible':'ineligible',completion.reasons,{...completion.snapshot,recordedAt:c.timestamp},c.timestamp);
 insert(c,'binary_calibration_mint_claims',{run_id:run.id,project_id:run.project_id,command_token:c.token});
 insert(c,'binary_calibration_exposure_checks',{id:check.id,run_id:run.id,project_id:run.project_id,phase:'completion',exposure_state:check.exposureState,eligibility_result:check.eligibility,eligibility_reasons:JSON.stringify(check.reasons),canonical_bytes:check.canonicalBytes,snapshot_digest:check.snapshotDigest,recorded_at:c.timestamp});
 const attempts=c.db.prepare('SELECT * FROM binary_calibration_attempts WHERE run_id=? ORDER BY trial_index,dataset_revision_item_digest').all(run.id);
 if(attempts.length!==run.planned_observations)throw repoError('state_conflict','binary calibration ledger coverage differs from the run plan');
 const auth=c.db.prepare('SELECT * FROM binary_calibration_exposure_checks WHERE id=?').get(String(run.authorization_check_id))!;
 const evidence=calibrationEvidence(run,attempts,{id:String(auth.id),snapshotDigest:String(auth.snapshot_digest),recordedAt:String(auth.recorded_at)},completion,check,c.timestamp);
 insert(c,'binary_calibration_private_ledgers',{id:evidence.ledgerId,run_id:run.id,project_id:run.project_id,artifact_id:evidence.artifactId,contract:BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT,canonical_bytes:evidence.ledgerBytes,commitment_digest:evidence.ledgerCommitment,created_at:c.timestamp});
 const artifactRow=insert(c,'binary_calibration_artifacts',{id:evidence.artifactId,run_id:run.id,project_id:run.project_id,private_ledger_id:evidence.ledgerId,artifact_revision:1,predecessor_artifact_id:null,correction_reason:null,status:evidence.artifact.status,contract:BINARY_CALIBRATION_CONTRACT,canonical_bytes:evidence.artifactBytes,artifact_digest:evidence.artifactDigest,evidence_digest:evidence.artifact.evidenceDigest,created_at:c.timestamp});
 const terminal=c.db.prepare("UPDATE binary_calibration_runs SET state=?,completion_check_id=?,artifact_id=?,artifact_digest=?,evidence_digest=?,completed_at=?,claim_worker_id=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=? RETURNING *").get(evidence.artifact.status,check.id,evidence.artifactId,evidence.artifactDigest,evidence.artifact.evidenceDigest,c.timestamp,run.id)!;
 const released=c.db.prepare('DELETE FROM binary_calibration_revision_leases WHERE run_id=? AND dataset_revision_id=?').run(run.id,run.dataset_revision_id);if(!released.changes)throw repoError('state_conflict','binary calibration revision lease disappeared during mint');
 insert(c,'binary_calibration_mint_finalizations',{run_id:run.id,project_id:run.project_id,command_token:c.token});
 return {run:rowToRun(terminal as unknown as RunRow),artifact:evidence.artifact,artifactCopy:artifactCopyFromRow(artifactRow),completion:{state:completion.exposureState,eligibility:check.eligibility,reasons:completion.reasons,snapshotDigest:check.snapshotDigest,eventId:check.id,recordedAt:c.timestamp}};
}
export function sqliteCalibrationMintCommands(db:DatabaseSync,clock=Date.now){
 initializeCalibrationMintValidator(db);initializeGovernedCapabilityValidator(db);initializeCalibrationValidator(db);
 return {
  finalizeRun(claim:BinaryCalibrationExecutionClaim):BinaryCalibrationMintResult{return sqliteCommand(db,c=>mint(db,c,requireCalibrationClaim(c,claim)),clock);},
  finalizeLifecycleForbiddenRun(claim:BinaryCalibrationExecutionClaim):BinaryCalibrationMintResult|null{return sqliteCommand(db,c=>{
   const run=requireCalibrationClaim(c,claim);if(!run.authorization_check_id)return null;
   // The lifecycle refusal statement aborts alone; a run it still authorizes is untouched.
   try{authorizeCalibrationLifecycle(c,run);return null;}catch(error){if(!(error instanceof BinaryCalibrationRepositoryError)||error.code!=='ineligible')throw error;}
   if(!c.db.prepare('SELECT 1 FROM binary_calibration_revision_leases WHERE run_id=? AND dataset_revision_id=?').get(run.id,run.dataset_revision_id))throw repoError('state_conflict','binary calibration revision lease is missing');
   // No call is made: a started call is permanently outcome_unknown, an unstarted one not_attempted.
   const accounted=c.db.prepare("UPDATE binary_calibration_attempts SET accounting_state='accounted',terminal_evaluator_outcome=CASE attempt_state WHEN 'started' THEN 'errored' ELSE 'not_attempted' END,error_code=CASE attempt_state WHEN 'started' THEN 'outcome_unknown' END,accounted_at=? WHERE run_id=? AND accounting_state='pending' AND attempt_state IN('started','not_started')").run(c.timestamp,run.id);
   const current=Number(accounted.changes)?c.db.prepare('UPDATE binary_calibration_runs SET accounted_observations=accounted_observations+? WHERE id=? RETURNING *').get(Number(accounted.changes),run.id) as unknown as RunRow:run;
   return mint(db,c,current);
  },clock);},
  getArtifact(access:BinaryCalibrationProjectAccess,id:string){const row=db.prepare('SELECT * FROM binary_calibration_artifacts WHERE id=? AND project_id=?').get(id,access.projectId);if(!row)throw repoError('not_found','binary calibration artifact not found');return artifactCopyFromRow(row);},
  getArtifactStatus(access:BinaryCalibrationProjectAccess,id:string):BinaryCalibrationArtifactStatusProjection{return sqliteCommand(db,c=>{
   const row=c.db.prepare("SELECT a.id,a.run_id,a.status,r.dataset_revision_id,x.recorded_at FROM binary_calibration_artifacts a JOIN binary_calibration_runs r ON r.id=a.run_id JOIN binary_calibration_exposure_checks x ON x.id=r.completion_check_id AND x.phase='completion' WHERE a.id=? AND a.project_id=?").get(id,access.projectId);if(!row)throw repoError('not_found','binary calibration artifact not found');
   const reasons=c.db.prepare('SELECT DISTINCT reason FROM binary_calibration_revocation_events WHERE artifact_id=?').all(id).map(row=>String(row.reason)) as BinaryCalibrationArtifactStatusReason[];
   if(c.db.prepare("SELECT 1 FROM dataset_exposure_events WHERE revision_id=? AND occurred_at>=? AND (exposure_class='development' OR activity IN('declassify','analysis_authoring','rubric_authoring','prompt_tuning','example_selection','model_selection','development_run','regression_run')) LIMIT 1").get(row.dataset_revision_id!,row.recorded_at!))reasons.push('development_exposure');
   const unique=[...new Set(reasons)].sort();return {contract:'rubrist/binary-calibration-artifact-status/v1',schemaVersion:1,artifactId:id,calibrationRunId:String(row.run_id),artifactStatus:row.status==='complete'?'complete':'incomplete',currentAdmissibility:unique.length?'revoked':'admissible',reasons:unique,evaluatedAt:c.timestamp};
  },clock);}
 };
}
