import { DatasetNotFoundError, DatasetRevisionConflictError, SealedValidationUnavailableError } from '../../repository/errors.js';
import { recordSqliteEvalExposure } from './eval-exposure.js';
import { SqliteFeatureUnavailableError } from './feature-error.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { verdictLabelFromPayload, ObservedCallSchema, EvaluatorFailureKindSchema } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { computeEvalRunSpend } from '../../repository/helpers.js';
import { evaluationDatabase, evalRun, evalItem, verdict, json, type Row } from './evaluation-values.js';
import { sqliteReceiptCommands } from './receipt-commands.js';
import { sqliteEvalExecution, EXECUTION_LEASE_MS } from './eval-execution.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
const finished=(row:Row|undefined)=>Boolean(row&&['completed','failed'].includes(row.status));
const clearExecution='execution_token=NULL,execution_claimed_at=NULL,provider_call_started_at=NULL,provider_call_returned_at=NULL,delivery_deadline_at=NULL';
export function sqliteEvalCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db),receipts=sqliteReceiptCommands(db);
  function runRow(projectId:string,evalRunId:string) { return one('SELECT * FROM eval_runs WHERE project_id=? AND id=?',projectId,evalRunId); }
  function verifyVerdict(projectId:string,caseId:string,versionId:string,verdictId:string,resultLabel:string,failingStep:number|undefined) {
    const row=one("SELECT * FROM verdicts WHERE project_id=? AND case_id=? AND skill_version_id=? AND id=? AND source='llm_judge'",projectId,caseId,versionId,verdictId);
    if(!row) throw new Error('Completion verdict must belong to the case and exact evaluator version');
    const value=verdict(row),payload=value.payload;
    if(verdictLabelFromPayload(payload)!==resultLabel || ('failingStep' in payload?payload.failingStep:undefined)!==failingStep) throw new Error('Completion verdict projection mismatch');
  }
  function bump(projectId:string,evalRunId:string,completed:number,failed:number,agreed:number,error:string|null,now:number) {
    run(`UPDATE eval_runs SET completed_items=completed_items+?,failed_items=failed_items+?,agreed_items=agreed_items+?,error=coalesce(error,?),
      status=CASE WHEN completed_items+failed_items+?+?=total_items THEN CASE WHEN completed_items+?=0 AND failed_items+?>0 THEN 'failed' ELSE 'completed' END ELSE status END,
      finished_at=CASE WHEN completed_items+failed_items+?+?=total_items THEN ? ELSE finished_at END WHERE project_id=? AND id=?`,
      completed,failed,agreed,error,completed,failed,completed,failed,completed,failed,new Date(now).toISOString(),projectId,evalRunId);
    const row=runRow(projectId,evalRunId)!;
    if(finished(row)&&row.trigger==='release_evidence') receipts.mint(projectId,evalRunId,now);
    return {runFinished:finished(row)};
  }
  function createOnce(input:Args<'createEvalRun'>[0]&{convergenceCaseId?:string;ingestionCaseId?:string}) { return transaction(now=> {
      if(input.datasetId&&!one('SELECT 1 FROM datasets WHERE project_id=? AND id=? AND archived_at IS NULL',input.projectId,input.datasetId)) throw new DatasetNotFoundError(input.datasetId);
      if(!['manual','api_batch','backfill','release_evidence'].includes(input.trigger)) throw new SqliteFeatureUnavailableError('SQLite evaluation source unavailable at this stage');
      if(input.datasetRevisionId) {
        const revision=one('SELECT * FROM dataset_revisions WHERE project_id=? AND id=?',input.projectId,input.datasetRevisionId);
        if(revision?.source_kind==='analysis_population')throw new DatasetRevisionConflictError('Analysis population revisions cannot run through the ordinary evaluation path');
        if(revision?.role==='sealed_validation')throw new SealedValidationUnavailableError();
      }
      const existing=input.trigger==='backfill'?one("SELECT id FROM eval_runs WHERE project_id=? AND skill_version_id=? AND trigger='backfill'",input.projectId,input.skillVersionId):
        input.ingestionCaseId?one('SELECT id FROM eval_runs WHERE project_id=? AND skill_version_id=? AND ingestion_case_id=?',input.projectId,input.skillVersionId,input.ingestionCaseId):
        input.convergenceCaseId?one("SELECT id FROM eval_runs WHERE project_id=? AND skill_version_id=? AND convergence_case_id=? AND status IN ('pending','running')",input.projectId,input.skillVersionId,input.convergenceCaseId):null;
      if(existing)return {run:commands.getEvalRunDetail(input.projectId,existing.id)!,created:false};

      const runId=`eval_${randomUUID()}`,stamp=new Date(now).toISOString();
      let completed=0,agreed=0,total=0;
      for(const item of input.items) {
        if(!['pending','completed','skipped'].includes(item.status??'pending')) throw new Error('Invalid evaluation item status at creation');
        if(item.status!=='skipped') total++;
        if(item.status==='completed') {
          verifyVerdict(input.projectId,item.caseId,input.skillVersionId,item.verdictId??'',item.resultLabel??'',item.failingStep);
          completed++;if(item.expectedLabel&&item.expectedLabel===item.resultLabel) agreed++;
        } else if(item.verdictId||item.resultLabel||item.cached) throw new Error('Only completed items may carry cached verdicts');
        if(input.trigger==='release_evidence'&&!one("SELECT 1 FROM cases WHERE project_id=? AND id=? AND case_type='release_evidence'",input.projectId,item.caseId)) throw new Error('Release evidence requires release evidence cases');
      }
      run(`INSERT INTO eval_runs(id,project_id,dataset_id,skill_version_id,trigger,status,blocking,total_items,completed_items,agreed_items,created_by_user_id,created_at,finished_at,dataset_revision_id,convergence_case_id,ingestion_case_id,source_trace_test_id,source_trace_test_revision,source_trace_test_validation_id,source_trace_test_validation_revision,source_trace_test_case_ref,source_trace_test_case_id,source_trace_test_dataset_item_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,runId,input.projectId,input.datasetId??null,input.skillVersionId,input.trigger,completed===total?'completed':'pending',Number(input.blocking??false),total,completed,agreed,input.createdByUserId??null,stamp,completed===total?stamp:null,input.datasetRevisionId??null,input.convergenceCaseId??null,input.ingestionCaseId??null,input.sourceTraceTest?.traceTestId??null,input.sourceTraceTest?.revision??null,input.sourceTraceTest?.validationId??null,input.sourceTraceTest?.validationRevision??null,input.sourceTraceTest?.sourceCaseRef??null,input.sourceTraceTest?.caseId??null,input.sourceTraceTest?.datasetItemId??null);
      for(const item of input.items) {
        const status=item.status??'pending';
        run(`INSERT INTO eval_run_items(id,project_id,eval_run_id,dataset_item_id,case_id,client_item_id,content_digest,status,verdict_id,expected_label,result_label,agreement,cached,created_at,finished_at,expected_fail_step,failing_step,provider_metadata,delivery_deadline_at,dataset_revision_item_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,`evali_${randomUUID()}`,input.projectId,runId,item.datasetItemId??null,item.caseId,item.clientItemId??null,item.contentDigest??null,status,item.verdictId??null,item.expectedLabel??null,item.resultLabel??null,
          status==='completed'&&item.expectedLabel?Number(item.expectedLabel===item.resultLabel):null,Number(item.cached??false),stamp,status==='pending'?null:stamp,item.expectedFailStep??null,item.failingStep??null,json(item.providerMetadata),status==='pending'?now+EXECUTION_LEASE_MS:null,item.datasetRevisionItemId??null);
      }
      if(completed===total&&input.trigger==='release_evidence') receipts.mint(input.projectId,runId,now);
      if(completed===total)recordSqliteEvalExposure(db,runRow(input.projectId,runId)!,now);
      return {run:commands.getEvalRunDetail(input.projectId,runId)!,created:true};
    }); }
  const commands={
    createEvalRun(input:Args<'createEvalRun'>[0]) {return createOnce(input).run;},
    createConvergenceEvalRun(input:Args<'createConvergenceEvalRun'>[0]) {return createOnce({...input,trigger:'manual',items:[{caseId:input.caseId}],convergenceCaseId:input.caseId});},
    createImportedCaseEvalRun(input:Args<'createImportedCaseEvalRun'>[0]) {return createOnce({...input,trigger:'api_batch',items:[{caseId:input.caseId}],ingestionCaseId:input.caseId});},
    getEvalRun(projectId:string,evalRunId:string) { const row=runRow(projectId,evalRunId);return row?evalRun(row):null; },
    getEvalRunItem(projectId:string,evalRunId:string,evalRunItemId:string) { const row=one('SELECT * FROM eval_run_items WHERE project_id=? AND eval_run_id=? AND id=?',projectId,evalRunId,evalRunItemId);return row?evalItem(row):null; },
    getEvalRunDetail(projectId:string,evalRunId:string) {
      const value=commands.getEvalRun(projectId,evalRunId);if(!value) return null;
      const items=all('SELECT * FROM eval_run_items WHERE project_id=? AND eval_run_id=? ORDER BY created_at,id',projectId,evalRunId).map(evalItem);
      return {...value,items,spend:computeEvalRunSpend(items)};
    },
    listEvalRuns(projectId:string,opts:Args<'listEvalRuns'>[1]={}) {
      return all(`SELECT * FROM eval_runs WHERE project_id=? AND(? IS NULL OR skill_version_id=?) AND(? IS NULL OR trigger='backfill' OR(?='first_assessment' AND trigger='api_batch' AND dataset_id IS NULL)) ORDER BY CASE WHEN ?='first_assessment' AND status IN ('pending','running') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT ?`,projectId,opts.skillVersionId??null,opts.skillVersionId??null,opts.purpose??null,opts.purpose??null,opts.purpose??null,sqliteLimit(opts.limit??50)).map(evalRun);
    },
    completeEvalRunItem(input:Args<'completeEvalRunItem'>[0]) { return transaction(now=> {
      const owner=runRow(input.projectId,input.evalRunId);
      const row=one("SELECT * FROM eval_run_items WHERE project_id=? AND eval_run_id=? AND id=? AND status='pending' AND execution_token=? AND execution_claimed_at>? AND provider_call_returned_at IS NOT NULL",input.projectId,input.evalRunId,input.evalRunItemId,input.executionToken??null,now-EXECUTION_LEASE_MS);
      if(!row||!owner||finished(owner)) return {runFinished:finished(owner)};
      verifyVerdict(input.projectId,row.case_id,owner.skill_version_id,input.verdictId,input.resultLabel,input.failingStep);
      const agreement=row.expected_label==null?null:Number(row.expected_label===input.resultLabel);
      run(`UPDATE eval_run_items SET status='completed',verdict_id=?,result_label=?,agreement=?,failing_step=?,latency_ms=?,input_tokens=?,output_tokens=?,provider_metadata=?,finished_at=?,${clearExecution} WHERE id=?`,input.verdictId,input.resultLabel,agreement,input.failingStep??null,input.latencyMs??null,input.inputTokens??null,input.outputTokens??null,json(input.providerMetadata),new Date(now).toISOString(),row.id);
      evalItem(one('SELECT * FROM eval_run_items WHERE id=?',row.id)!);
      return bump(input.projectId,input.evalRunId,1,0,agreement??0,null,now);
    }); },
    failEvalRunItem(input:Args<'failEvalRunItem'>[0]) { return transaction(now=> {
      const owner=runRow(input.projectId,input.evalRunId);
      const row=one("SELECT * FROM eval_run_items WHERE project_id=? AND eval_run_id=? AND id=? AND status='pending' AND execution_token=?",input.projectId,input.evalRunId,input.evalRunItemId,input.executionToken??null);
      if(!row||!owner||finished(owner)) return {runFinished:finished(owner)};
      const failure=input.failure;
      const expired=row.execution_claimed_at<=now-EXECUTION_LEASE_MS;
      if(input.recoverExpiredClaim) {
        if(!expired) return {runFinished:false};
        const dispatched=row.provider_call_started_at!==null||row.provider_call_returned_at!==null;
        if(dispatched ? !(failure.state==='failure'&&failure.failureKind==='outcome_unknown') : failure.state!=='not_attempted') return {runFinished:false};
      } else if(expired) return {runFinished:false};
      if(failure.state==='not_attempted'&&row.provider_call_started_at!==null&&failure.executorRefused!==true) return {runFinished:false};
      if(failure.state==='failure') { ObservedCallSchema.parse(failure.observed);EvaluatorFailureKindSchema.parse(failure.failureKind); }
      run(`UPDATE eval_run_items SET status='failed',error=?,failure_kind=?,not_attempted=?,observed=?,finished_at=?,${clearExecution} WHERE id=?`,input.error,failure.state==='failure'?failure.failureKind:null,Number(failure.state==='not_attempted'),failure.state==='failure'?json(failure.observed):null,new Date(now).toISOString(),row.id);
      return bump(input.projectId,input.evalRunId,0,1,0,input.error,now);
    }); },
    deleteUndispatchedEvalRun(projectId:string,evalRunId:string) { transaction(()=>run("DELETE FROM eval_runs WHERE project_id=? AND id=? AND status='pending' AND completed_items=0 AND failed_items=0 AND queue_dispatched_at IS NULL AND queue_dispatch_token IS NULL AND NOT EXISTS(SELECT 1 FROM eval_run_items i WHERE i.eval_run_id=eval_runs.id AND (i.execution_token IS NOT NULL OR i.queue_job_id IS NOT NULL))",projectId,evalRunId)); }
  };
  return {...commands,...sqliteEvalExecution(db),...receipts.commands};
}
