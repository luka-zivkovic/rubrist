import {randomBytes} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {BinaryCalibrationExecutionClaim,BinaryCalibrationProjectAccess,BinaryCalibrationRecheckTarget} from '../../binary-calibration/repository.js';
import {validateClaimInput,claimFromRow,repoError,rowToRun,parseJson,type RunRow} from '../../binary-calibration/storage-values.js';
import {ExecutionBindingSchema,type CapabilityProbe} from '@rubrist/shared';
import {sqliteCommand,type SqliteCommandContext} from './command-context.js';
import {sqliteResolutionStore} from './resolution-commands.js';

export function requireCalibrationClaim(c:SqliteCommandContext,claim:BinaryCalibrationExecutionClaim):RunRow {
 const row=c.db.prepare("SELECT * FROM binary_calibration_runs WHERE id=? AND claim_worker_id=? AND claim_token=? AND state IN('running','recovery_required') AND claim_expires_at>=?").get(claim.runId,claim.workerId,claim.claimToken,c.timestamp);
 if(!row)throw repoError('state_conflict','binary calibration worker claim is stale');
 return row as unknown as RunRow;
}
/** Private synchronous controls. The durable claim is distinct from command identity. */
export function sqliteCalibrationClaimCommands(db:DatabaseSync,clock=Date.now){
 const store=sqliteResolutionStore(db);
 return {
  listRuns(access:BinaryCalibrationProjectAccess){return db.prepare('SELECT * FROM binary_calibration_runs WHERE project_id=? ORDER BY created_at DESC,id DESC').all(access.projectId).map(row=>rowToRun(row as unknown as RunRow));},
  getRun(access:BinaryCalibrationProjectAccess,runId:string){const row=db.prepare('SELECT * FROM binary_calibration_runs WHERE id=? AND project_id=?').get(runId,access.projectId);if(!row)throw repoError('not_found','binary calibration run not found');return rowToRun(row as unknown as RunRow);},
  listRunnableRunIds(limit:number){if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw repoError('unsupported','runnable calibration limit must be an integer from 1 to 1000');return sqliteCommand(db,c=>c.db.prepare("SELECT id FROM binary_calibration_runs WHERE state IN('queued','recovery_required') OR (state='running' AND claim_expires_at<?) ORDER BY created_at,id LIMIT ?").all(c.timestamp,limit).map(row=>String(row.id)),clock);},
  claimRun(runId:string,workerId:string,ttl:number){validateClaimInput(workerId,ttl);return sqliteCommand(db,c=>{const row=c.db.prepare("UPDATE binary_calibration_runs SET state='running',claim_worker_id=?,claim_token=?,claim_expires_at=? WHERE id=? AND state IN('queued','running','recovery_required') AND (claim_token IS NULL OR claim_expires_at<?) RETURNING *").get(workerId,randomBytes(32).toString('hex'),new Date(c.milliseconds+ttl).toISOString(),runId,c.timestamp);return row?claimFromRow(row):null;},clock);},
  heartbeatClaim(claim:BinaryCalibrationExecutionClaim,ttl:number){validateClaimInput(claim.workerId,ttl);return sqliteCommand(db,c=>{requireCalibrationClaim(c,claim);return claimFromRow(c.db.prepare('UPDATE binary_calibration_runs SET claim_expires_at=? WHERE id=? RETURNING *').get(new Date(c.milliseconds+ttl).toISOString(),claim.runId)!);},clock);},
  getRecheckTarget(claim:BinaryCalibrationExecutionClaim):BinaryCalibrationRecheckTarget{return sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim),binding=store.binding(String(run.project_id),String(run.skill_version_id));if(!binding)throw repoError('state_conflict','binary calibration evaluator version is unavailable');const executionBinding=ExecutionBindingSchema.parse(parseJson(run.execution_binding));const latest=c.db.prepare("SELECT max(recorded_at) stamp FROM evaluator_resolution_attempts WHERE project_id=? AND trigger_kind='binary_calibration_run' AND trigger_ref=? AND kind='recheck' AND outcome='unknown'").get(String(run.project_id),String(run.id));return {binding:{...binding,executionBinding,record:store.load(String(run.project_id),String(run.skill_version_id),executionBinding)},authorized:run.authorization_check_id!=null,msSinceUnknownRecheck:latest?.stamp==null?null:c.milliseconds-Date.parse(String(latest.stamp))};},clock);},
  recordRecheck(claim:BinaryCalibrationExecutionClaim,result:{outcome:'holds'|'no_longer_holds'|'unknown';probes:readonly CapabilityProbe[]}){sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim);store.append({projectId:String(run.project_id),skillVersionId:String(run.skill_version_id),executionBinding:ExecutionBindingSchema.parse(parseJson(run.execution_binding)),kind:'recheck',triggerKind:'binary_calibration_run',triggerRef:String(run.id),outcome:result.outcome,probes:result.probes},c.timestamp);},clock);},
  rejectBeforeAuthorization(claim:BinaryCalibrationExecutionClaim,reason:'resolution_no_longer_holds'){sqliteCommand(db,c=>{const run=requireCalibrationClaim(c,claim);if(run.authorization_check_id)throw repoError('state_conflict','binary calibration run is already authorized');c.db.prepare("UPDATE binary_calibration_runs SET state='rejected',rejection_reason=?,completed_at=?,claim_worker_id=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=?").run(reason,c.timestamp,claim.runId);},clock);},
  markRecoveryRequired(claim:BinaryCalibrationExecutionClaim){sqliteCommand(db,c=>{const result=c.db.prepare("UPDATE binary_calibration_runs SET state='recovery_required',claim_worker_id=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=? AND claim_worker_id=? AND claim_token=? AND state='running'").run(claim.runId,claim.workerId,claim.claimToken);if(!result.changes)throw repoError('state_conflict','binary calibration worker claim is stale');},clock);}
 };
}
