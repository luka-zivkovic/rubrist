import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RegressionRunResultSchema, regressionDirectionCounts, type GateRunJob, type RegressionRunResult } from '@rubrist/shared';
import { DatasetRevisionConflictError, GateRunBindingMismatchError } from '../../repository/errors.js';
import { sqliteSkillVersion } from './definition-commands.js';
import { evaluationDatabase, json, parse, type Row } from './evaluation-values.js';
export const REGRESSION_LEASE_MS=5*60_000;
const outcome=(r:Row)=>RegressionRunResultSchema.parse({id:r.id,skillVersionId:r.skill_version_id,datasetRevisionId:r.dataset_revision_id,status:r.status,compared:r.compared,regressed:r.regressed,improved:r.improved,flipped:r.flipped,overrideReason:r.override_reason??undefined,goldenSetMissing:Boolean(r.golden_set_missing),cases:parse(r.cases),error:r.error_message,createdAt:r.created_at});
export type RegressionAttempt={projectId:string;skillVersionId:string;token:string;epoch:number};
export function sqliteRegressionCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db);
 function version(job:GateRunJob) {
  const row=one('SELECT * FROM skill_versions WHERE project_id=? AND id=?',job.projectId,job.skillVersionId);
  if(!row)throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
  if(!row.regression_dataset_revision_id)throw new DatasetRevisionConflictError('Evaluator has no immutable regression dataset binding.');
  if(job.datasetRevisionId!==row.regression_dataset_revision_id)throw new GateRunBindingMismatchError(job.datasetRevisionId,row.regression_dataset_revision_id);
  return row;
 }
 function existing(projectId:string,versionId:string) {const row=one('SELECT * FROM regression_runs WHERE project_id=? AND skill_version_id=?',projectId,versionId);return row?outcome(row):null;}
 function owned(a:RegressionAttempt,now:number) {return one('SELECT * FROM regression_gate_attempts WHERE project_id=? AND skill_version_id=? AND token=? AND epoch=? AND lease_until>?',a.projectId,a.skillVersionId,a.token,a.epoch,now);}
 function finish(job:GateRunJob,result:RegressionRunResult,now:number) {
  const row=version(job);if(row.status!=='calibrating'||existing(job.projectId,job.skillVersionId))return false;
  RegressionRunResultSchema.parse(result);
  if(result.skillVersionId!==job.skillVersionId||result.datasetRevisionId!==job.datasetRevisionId)throw new DatasetRevisionConflictError('Regression result binding mismatch');
  run('INSERT INTO regression_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',result.id,job.projectId,result.skillVersionId,row.criterion_version_id,result.datasetRevisionId,result.status,result.compared,result.regressed,result.improved,result.flipped,result.overrideReason??null,job.actorUserId??null,Number(result.goldenSetMissing),json(result.cases),result.error??null,result.createdAt);
  const counts=regressionDirectionCounts(result.cases),stamp=new Date(now).toISOString();
  const limitations=result.status==='error'?[`regression gate failed: ${result.error}`]:result.goldenSetMissing?['no golden-set cases are available; regression gate is advisory only']:result.regressed>0?['regressed on one or more golden-set cases']:[];
  run('UPDATE skill_versions SET status=?,golden_set_agreement=?,too_strict_count=?,too_lenient_count=?,ambiguous_count=?,known_limitations=?,approved_at=? WHERE id=?',result.status==='error'?'failed':result.status==='blocked'?'regressing':'approved',result.compared===0?null:(result.compared-result.regressed)/result.compared,counts.tooStrict,counts.tooLenient,counts.ambiguous,json(limitations),['passed','overridden'].includes(result.status)?stamp:null,row.id);
  run(`INSERT INTO dataset_exposure_events(id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key,occurred_at)
    VALUES(?,?,?,'evaluator_execution','development','regression_run','evaluator_version',?,?,'regression_run',?,?,'{}',?,?)`, `dse_${randomUUID()}`,job.projectId,job.datasetRevisionId,job.skillVersionId,job.actorUserId??null,result.id,result.error??null,`regression-run:${result.id}`,stamp);
  if(result.overrideReason)run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',`audit_${randomUUID()}`,job.projectId,job.actorUserId??null,'skill_version.override','skill_version',row.id,json({overrideReason:result.overrideReason}),stamp);
  run('UPDATE regression_gate_attempts SET token=NULL,lease_until=NULL,provider_started_at=NULL WHERE project_id=? AND skill_version_id=?',job.projectId,job.skillVersionId);
  return true;
 }
 return {
  getRegressionRunForVersion:existing,
  listRegressionRunsForVersions(projectId:string,versionIds:string[]) {if(!versionIds.length)return [];return all(`SELECT * FROM regression_runs WHERE project_id=? AND skill_version_id IN (SELECT value FROM json_each(?)) ORDER BY skill_version_id`,projectId,json(versionIds)).map(outcome);},
  getRegressionPriorRun(projectId:string,versionId:string) {const row=one(`SELECT old.id FROM skill_versions current JOIN skill_versions old ON old.project_id=current.project_id AND old.skill_id=current.skill_id AND old.criterion_version_id=current.criterion_version_id AND old.id<>current.id WHERE current.project_id=? AND current.id=? ORDER BY old.created_at DESC,old.id DESC LIMIT 1`,projectId,versionId);return row?existing(projectId,row.id):null;},
  claimRegressionAttempt(job:GateRunJob,token:string) {return transaction(now=>{
   if(!token)throw new Error('Regression token required');
   const row=version(job),result=existing(job.projectId,job.skillVersionId);if(result)return {state:'terminal' as const,version:sqliteSkillVersion(row),regressionRun:result};
   if(row.status!=='calibrating')throw new Error('Evaluator is not pending regression');
   const attempt=one('SELECT * FROM regression_gate_attempts WHERE project_id=? AND skill_version_id=?',job.projectId,job.skillVersionId);
   if(attempt?.token&&attempt.lease_until>now)return {state:'busy' as const};
   const epoch=Number(attempt?.epoch??0)+1;
   run(`INSERT INTO regression_gate_attempts VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(project_id,skill_version_id) DO UPDATE SET epoch=excluded.epoch,token=excluded.token,lease_until=excluded.lease_until,provider_started_at=NULL,uncertain_epochs=excluded.uncertain_epochs`,job.projectId,job.skillVersionId,job.datasetRevisionId,epoch,token,now+REGRESSION_LEASE_MS,Number(attempt?.uncertain_epochs??0)+Number(attempt?.provider_started_at!=null));
   return {state:'claimed' as const,epoch,version:sqliteSkillVersion(row)};
  });},
  touchRegressionAttempt(a:RegressionAttempt,start:boolean) {return transaction(now=>{if(!owned(a,now))return false;run('UPDATE regression_gate_attempts SET lease_until=?,provider_started_at=CASE WHEN ? THEN coalesce(provider_started_at,?) ELSE provider_started_at END WHERE project_id=? AND skill_version_id=?',now+REGRESSION_LEASE_MS,Number(start),now,a.projectId,a.skillVersionId);return true;});},
  // Release follows every settled provider call. A still-live owner therefore
  // knows each dispatch outcome; only an expired lease stays uncertain.
  releaseRegressionAttempt(a:RegressionAttempt) {transaction(now=>run('UPDATE regression_gate_attempts SET token=NULL,lease_until=NULL,provider_started_at=CASE WHEN lease_until>? THEN NULL ELSE provider_started_at END WHERE project_id=? AND skill_version_id=? AND token=? AND epoch=?',now,a.projectId,a.skillVersionId,a.token,a.epoch));},
  finishRegressionAttempt(a:RegressionAttempt,job:GateRunJob,result:RegressionRunResult) {return transaction(now=>{if(a.projectId!==job.projectId||a.skillVersionId!==job.skillVersionId)throw new DatasetRevisionConflictError('Regression attempt and outcome ownership mismatch');return owned(a,now)?finish(job,result,now):false;});},
  failRegressionGate(job:GateRunJob,message:string) {return transaction(now=>{
   const row=version(job);if(existing(job.projectId,job.skillVersionId)||row.status!=='calibrating')return true;
   if(one('SELECT 1 FROM regression_gate_attempts WHERE project_id=? AND skill_version_id=? AND token IS NOT NULL AND lease_until>?',job.projectId,job.skillVersionId,now))return false;
   return finish(job,{id:`reg_${randomUUID()}`,skillVersionId:job.skillVersionId,datasetRevisionId:job.datasetRevisionId,status:'error',compared:0,regressed:0,improved:0,flipped:0,error:message,goldenSetMissing:false,cases:[],createdAt:new Date(now).toISOString()},now);
  });}
 };
}
