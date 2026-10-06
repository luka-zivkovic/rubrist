import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ExecutionBindingSchema } from '@rubrist/shared';
import type { FeedbackSyncProvider } from '../../repository/contracts.js';
import type { RubristRepository } from '../../repository.js';
import { FeedbackSyncJobNotFoundError, FeedbackSyncCredentialsMissingError } from '../../repository/errors.js';
import { PROVISIONAL_FEEDBACK_HOLD } from '../../lib/provisional-feedback.js';
import { rowToFeedbackSyncJobRecord } from '../../repository.pg/mappers.js';
import { sqliteIntegrationCommands } from './integration-commands.js';
import { evaluationDatabase } from './evaluation-values.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
export function sqliteFeedbackCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db),integrations=sqliteIntegrationCommands(db);
 const joins=`FROM feedback_sync_jobs f JOIN judge_runs j ON j.id=f.judge_run_id AND j.project_id=f.project_id JOIN cases c ON c.id=j.case_id AND c.project_id=j.project_id JOIN raw_traces r ON r.id=c.raw_trace_id AND r.project_id=c.project_id`;
 function refresh(projectId:string,now:number) {
  run(`UPDATE projects SET sync_back_coverage=coalesce((SELECT sum(status='synced')*1.0/nullif(count(*),0) FROM feedback_sync_jobs WHERE project_id=?),0),updated_at=? WHERE id=?`,projectId,new Date(now).toISOString(),projectId);
 }
 function mark(job:Args<'markFeedbackSyncSucceeded'>[0],status:'synced'|'failed'|'blocked',error?:unknown) {transaction(now=>{
  run(`UPDATE feedback_sync_jobs SET status=?,last_error=?,attempts=attempts+? WHERE project_id=? AND id=? AND status<>'synced'`,status,status==='synced'?null:error instanceof Error?error.message:String(error),Number(status==='failed'),job.projectId,job.feedbackSyncJobId);
  refresh(job.projectId,now);
 });}
 return {
  createFeedbackSyncJob(input:Args<'createFeedbackSyncJob'>[0]) {return transaction(now=>{
   const row=one(`INSERT INTO feedback_sync_jobs(id,project_id,judge_run_id,provider,status,created_at)
    SELECT ?,j.project_id,j.id,?,'pending',? FROM judge_runs j JOIN cases c ON c.id=j.case_id AND c.project_id=j.project_id JOIN raw_traces r ON r.id=c.raw_trace_id AND r.project_id=c.project_id JOIN integrations i ON i.id=r.source_integration_id AND i.project_id=r.project_id AND i.provider=?
    WHERE j.project_id=? AND j.id=? ON CONFLICT(judge_run_id,provider) DO NOTHING RETURNING *`,`fsync_${randomUUID()}`,input.provider,new Date(now).toISOString(),input.provider,input.projectId,input.judgeRunId)
    ??one("SELECT * FROM feedback_sync_jobs WHERE project_id=? AND judge_run_id=? AND provider=? AND status<>'synced'",input.projectId,input.judgeRunId,input.provider);
   return row?rowToFeedbackSyncJobRecord(row):null;
  });},
  loadFeedbackSyncContext(job:Args<'loadFeedbackSyncContext'>[0]):Awaited<ReturnType<RubristRepository['loadFeedbackSyncContext']>> {
   const row=one(`SELECT f.id,f.status,f.project_id,f.provider,j.*,j.id judge_run_id,r.source_trace_id,r.source_trace_version,r.source_integration_id,sv.execution_binding,ct.stable_key criterion_stable_key,f.id feedback_id,f.status feedback_status ${joins}
    JOIN skill_versions sv ON sv.id=j.skill_version_id AND sv.project_id=j.project_id JOIN criteria ct ON ct.id=sv.criterion_id AND ct.project_id=sv.project_id
    JOIN integrations i ON i.id=r.source_integration_id AND i.project_id=r.project_id AND i.provider=f.provider WHERE f.project_id=? AND f.id=?`,job.projectId,job.feedbackSyncJobId);
   if(!row)throw new FeedbackSyncJobNotFoundError(job.feedbackSyncJobId);
   const context={projectId:job.projectId,integrationId:String(row.source_integration_id),limit:25};
   let integration;
   try {integration=row.provider==='langfuse'?integrations.loadLangfuseImportContext(context):row.provider==='ironside'?integrations.loadIronsideImportContext(context):integrations.loadLangSmithImportContext(context);}
   catch {throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);}
   return {id:String(row.feedback_id),status:row.feedback_status,projectId:job.projectId,provider:row.provider as FeedbackSyncProvider,sourceTraceId:String(row.source_trace_id),sourceTraceVersion:row.source_trace_version??null,criterionStableKey:String(row.criterion_stable_key),
    judgeRun:{id:String(row.judge_run_id),projectId:job.projectId,caseId:String(row.case_id),skillVersionId:String(row.skill_version_id),executionBinding:ExecutionBindingSchema.parse(JSON.parse(row.execution_binding)),verdict:row.verdict,score:Number(row.score),reasoning:row.reasoning??null,createdAt:String(row.created_at)},
    integration:{...integration,pollEnabled:true,pollIntervalSeconds:300,pollLimit:25,lastTestedAt:null,lastTestResult:null}};
  },
  listFeedbackSyncJobs(input:Args<'listFeedbackSyncJobs'>[0]) {return all('SELECT * FROM feedback_sync_jobs WHERE project_id=? AND(? IS NULL OR status=?) ORDER BY created_at DESC,id DESC LIMIT ?',input.projectId,input.status??null,input.status??null,sqliteLimit(input.limit)).map(row=>({...rowToFeedbackSyncJobRecord(row),attempts:Number(row.attempts),lastError:row.last_error as string|null,createdAt:String(row.created_at)}));},
  markFeedbackSyncSucceeded:(job:Args<'markFeedbackSyncSucceeded'>[0])=>mark(job,'synced'),
  markFeedbackSyncFailed:(job:Args<'markFeedbackSyncFailed'>[0],error:unknown)=>mark(job,'failed',error),
  markFeedbackSyncBlocked:(job:Args<'markFeedbackSyncBlocked'>[0],error:unknown)=>mark(job,'blocked',error),
  markFeedbackSyncPending(job:Args<'markFeedbackSyncPending'>[0]) {run("UPDATE feedback_sync_jobs SET status='pending',last_error=NULL WHERE project_id=? AND id=? AND status='blocked'",job.projectId,job.feedbackSyncJobId);},
  listBlockedIronsideFeedbackSyncJobs(projectId:string,integrationId:string) {return all(`SELECT f.id ${joins} WHERE f.project_id=? AND r.source_integration_id=? AND f.provider='ironside' AND f.status='blocked' ORDER BY f.created_at,f.id`,projectId,integrationId).map(row=>({projectId,feedbackSyncJobId:String(row.id)}));},
  listSignedOffFeedbackSyncJobs(limit:number) {return all(`SELECT f.id,f.project_id FROM feedback_sync_jobs f JOIN judge_runs j ON j.id=f.judge_run_id AND j.project_id=f.project_id JOIN skill_versions sv ON sv.id=j.skill_version_id AND sv.project_id=j.project_id WHERE f.status='blocked' AND f.last_error=? AND sv.approved_at IS NOT NULL ORDER BY f.created_at,f.id LIMIT ?`,PROVISIONAL_FEEDBACK_HOLD,sqliteLimit(limit)).map(row=>({projectId:String(row.project_id),feedbackSyncJobId:String(row.id)}));}
 };
}
