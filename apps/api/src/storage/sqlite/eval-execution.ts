import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RubristRepository } from '../../repository.js';
import type { EvalRunItemExecutionClaim, EvalRunItemReleaseDisposition } from '../../repository/contracts.js';
import { evaluationDatabase, evalItem } from './evaluation-values.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
export const EXECUTION_LEASE_MS=15*60_000;
const DISPATCH_LEASE_MS=5*60_000;
export function sqliteEvalExecution(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db);
  const active=`EXISTS(SELECT 1 FROM eval_runs r WHERE r.project_id=eval_run_items.project_id AND r.id=eval_run_items.eval_run_id AND r.status IN ('pending','running'))`;
  const pending=`project_id=? AND eval_run_id=? AND status='pending' AND ${active}`;
  const owned=`${pending} AND id=? AND execution_token=?`;
  const identity=(input:Args<'claimEvalRunItemExecution'>[0])=>[input.projectId,input.evalRunId,input.evalRunItemId,input.executionToken];
  function arm(projectId:string,evalRunId:string,now:number) { run(`UPDATE eval_run_items SET delivery_deadline_at=? WHERE ${pending}`,now+EXECUTION_LEASE_MS,projectId,evalRunId); }
  return {
    claimEvalRunDispatch(input:Args<'claimEvalRunDispatch'>[0]):Awaited<ReturnType<RubristRepository['claimEvalRunDispatch']>> {
      return transaction(now=> {
        const row=one(`UPDATE eval_runs SET queue_job_id=coalesce(queue_job_id,?),queue_dispatch_token=?,queue_dispatch_claimed_at=?
          WHERE project_id=? AND id=? AND status IN ('pending','running') AND queue_dispatched_at IS NULL AND (queue_dispatch_token IS NULL OR queue_dispatch_claimed_at<=?) RETURNING queue_job_id`,
          randomUUID(),input.dispatchToken,now,input.projectId,input.evalRunId,now-DISPATCH_LEASE_MS);
        if(row) return {state:'claimed',jobId:String(row.queue_job_id)};
        const existing=one('SELECT * FROM eval_runs WHERE project_id=? AND id=?',input.projectId,input.evalRunId);
        return {state:existing?.queue_dispatched_at!=null?'dispatched':'busy',jobId:existing?.queue_job_id??null};
      });
    },
    rotateEvalRunDispatchJob(input:Args<'rotateEvalRunDispatchJob'>[0]) { return transaction(now=>one(`UPDATE eval_runs SET queue_job_id=? WHERE project_id=? AND id=? AND queue_dispatch_token=? AND queue_dispatched_at IS NULL AND queue_dispatch_claimed_at>? RETURNING queue_job_id`,randomUUID(),input.projectId,input.evalRunId,input.dispatchToken,now-DISPATCH_LEASE_MS)?.queue_job_id as string??null); },
    markEvalRunDispatched(input:Args<'markEvalRunDispatched'>[0]) { transaction(now=> {
      if(run(`UPDATE eval_runs SET queue_dispatched_at=?,queue_dispatch_token=NULL,queue_dispatch_claimed_at=NULL WHERE project_id=? AND id=? AND queue_dispatch_token=? AND queue_dispatch_claimed_at>?`,now,input.projectId,input.evalRunId,input.dispatchToken,now-DISPATCH_LEASE_MS).changes) arm(input.projectId,input.evalRunId,now);
    }); },
    releaseEvalRunDispatch(input:Args<'releaseEvalRunDispatch'>[0]) { transaction(()=>run('UPDATE eval_runs SET queue_dispatch_token=NULL,queue_dispatch_claimed_at=NULL WHERE project_id=? AND id=? AND queue_dispatch_token=? AND queue_dispatched_at IS NULL',input.projectId,input.evalRunId,input.dispatchToken)); },
    armEvalRunItemDeliveryDeadline(projectId:string,evalRunId:string) { transaction(now=>arm(projectId,evalRunId,now)); },
    markEvalRunRunning(projectId:string,evalRunId:string) { transaction(now=>run("UPDATE eval_runs SET status='running',started_at=? WHERE project_id=? AND id=? AND status='pending'",new Date(now).toISOString(),projectId,evalRunId)); },
    listPendingEvalRunItems(projectId:string,evalRunId:string) { return all(`SELECT * FROM eval_run_items WHERE ${pending} ORDER BY created_at,id`,projectId,evalRunId).map(evalItem); },
    listPendingEvalRunItemDispatches(projectId:string,evalRunId:string) { return transaction(()=>all(`SELECT * FROM eval_run_items WHERE ${pending} ORDER BY created_at,id`,projectId,evalRunId).map(row=> {
      const jobId=row.queue_job_id??randomUUID(); run('UPDATE eval_run_items SET queue_job_id=? WHERE id=?',jobId,row.id);
      return {item:evalItem(row),jobId:String(jobId)};
    })); },
    claimEvalRunItemExecution(input:Args<'claimEvalRunItemExecution'>[0]):EvalRunItemExecutionClaim { return transaction(now=> {
      if(!input.executionToken) throw new Error('Execution token required');
      const row=one(`SELECT * FROM eval_run_items WHERE ${pending} AND id=?`,input.projectId,input.evalRunId,input.evalRunItemId);
      if(!row) return {state:'terminal'};
      if(row.execution_token!==null) {
        if(row.execution_claimed_at>now-EXECUTION_LEASE_MS) return {state:'busy'};
        if(row.provider_call_started_at!==null) return {state:'outcome_unknown',executionToken:row.execution_token,providerCallReturned:row.provider_call_returned_at!==null};
      }
      run('UPDATE eval_run_items SET execution_token=?,execution_claimed_at=?,delivery_deadline_at=? WHERE id=?',input.executionToken,now,now+EXECUTION_LEASE_MS,row.id);
      return {state:'claimed'};
    }); },
    rearmEvalRunItemDeliveryDeadline(projectId:string,evalRunId:string,evalRunItemId:string) { return transaction(now=>run(`UPDATE eval_run_items SET delivery_deadline_at=? WHERE ${pending} AND id=? AND execution_token IS NULL`,now+EXECUTION_LEASE_MS,projectId,evalRunId,evalRunItemId).changes>0); },
    claimEvalRunItemRecovery(input:Args<'claimEvalRunItemRecovery'>[0]) { return transaction(now=> {
      if(!input.executionToken) throw new Error('Execution token required');
      return run(`UPDATE eval_run_items SET execution_token=?,execution_claimed_at=? WHERE ${pending} AND id=? AND execution_token IS NULL AND delivery_deadline_at<=?`,input.executionToken,now,input.projectId,input.evalRunId,input.evalRunItemId,now).changes>0;
    }); },
    beginEvalRunItemProviderCall(input:Args<'beginEvalRunItemProviderCall'>[0]) { return transaction(now=>run(`UPDATE eval_run_items SET provider_call_started_at=? WHERE ${owned} AND execution_claimed_at>? AND provider_call_started_at IS NULL`,now,...identity(input),now-EXECUTION_LEASE_MS).changes>0); },
    markEvalRunItemProviderCallReturned(input:Args<'markEvalRunItemProviderCallReturned'>[0]) { return transaction(now=>run(`UPDATE eval_run_items SET provider_call_returned_at=? WHERE ${owned} AND execution_claimed_at>? AND provider_call_started_at IS NOT NULL AND provider_call_returned_at IS NULL`,now,...identity(input),now-EXECUTION_LEASE_MS).changes>0); },
    releaseEvalRunItemExecution(input:Args<'releaseEvalRunItemExecution'>[0],options:Args<'releaseEvalRunItemExecution'>[1]={}):EvalRunItemReleaseDisposition { return transaction(now=> {
      const row=one(`SELECT * FROM eval_run_items WHERE ${owned}`,...identity(input));
      if(!row) return {state:'lost'};
      if(row.provider_call_started_at!==null) return {state:'provider_started',providerCallReturned:row.provider_call_returned_at!==null};
      if(options.preservePreCallClaim) return {state:'pre_call_held'};
      run('UPDATE eval_run_items SET execution_token=NULL,execution_claimed_at=NULL,delivery_deadline_at=? WHERE id=?',now+EXECUTION_LEASE_MS,row.id);
      return {state:'released'};
    }); },
    listStaleEvalRunItemExecutions() { const now=Date.now(); return all(`SELECT * FROM eval_run_items WHERE status='pending' AND ${active} AND
      ((execution_token IS NOT NULL AND execution_claimed_at<=?) OR (execution_token IS NULL AND delivery_deadline_at<=?)) ORDER BY created_at,id LIMIT 100`,now-EXECUTION_LEASE_MS,now).map(row=>({projectId:String(row.project_id),evalRunId:String(row.eval_run_id),evalRunItemId:String(row.id),executionToken:row.execution_token as string|null,providerCallStarted:row.provider_call_started_at!==null,providerCallReturned:row.provider_call_returned_at!==null})); }
  };
}
