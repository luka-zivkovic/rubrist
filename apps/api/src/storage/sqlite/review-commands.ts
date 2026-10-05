import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ReviewQueueSchema, ReviewQueueItemSchema, VerdictRecordSchema, ReviewContextSchema } from '@rubrist/shared';
import type { RubristRepository, RecordVerdictInput } from '../../repository.js';
import { AmbiguousProjectSkillError, DatasetRevisionConflictError } from '../../repository/errors.js';
import { suggestReviewBatch, REVIEW_CANDIDATE_LIMIT } from '../../lib/review-priority.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { evaluationDatabase, camel, verdict, json, parse } from './evaluation-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
export function sqliteReviewCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db);
  const item=(row:Record<string,any>)=>ReviewQueueItemSchema.parse(camel(row));
  const queue=(row:Record<string,any>)=>ReviewQueueSchema.parse(camel(row));
  const selection=`SELECT q.*,(SELECT count(*) FROM review_queue_items i WHERE i.queue_id=q.id AND i.status='pending') pending_count,
    (SELECT count(*) FROM review_queue_items i WHERE i.queue_id=q.id AND i.status='completed') completed_count FROM review_queues q`;
  function criterion(projectId:string,requested?:string,versionId?:string):string {
    if(versionId) {
      const row=one('SELECT criterion_version_id FROM skill_versions WHERE project_id=? AND id=?',projectId,versionId);
      if(!row||requested&&requested!==row.criterion_version_id)throw new DatasetRevisionConflictError('Evaluator version does not match this project and criterion');
      return row.criterion_version_id;
    }
    if(requested) {
      if(!one('SELECT 1 FROM skill_versions WHERE project_id=? AND criterion_version_id=?',projectId,requested))throw new DatasetRevisionConflictError('Criterion version is not bound to an evaluator in this project');
      return requested;
    }
    const version=definitions.getCurrentSkill(projectId).currentVersion;
    return one('SELECT criterion_version_id FROM skill_versions WHERE project_id=? AND id=?',projectId,version.id)!.criterion_version_id;
  }
  function pin(projectId:string,caseId:string,criterionId:string,versionId?:string,judgeId?:string) {
    if(!one('SELECT 1 FROM cases WHERE project_id=? AND id=?',projectId,caseId))throw new Error(`Cases not found in project: ${caseId}`);
    if(!versionId)return {skillVersionId:null,judgeRunId:null};
    const row=one(`SELECT r.id FROM judge_runs r JOIN skill_versions v ON v.id=r.skill_version_id AND v.project_id=r.project_id WHERE r.project_id=? AND r.case_id=? AND r.skill_version_id=? AND v.criterion_version_id=? AND (? IS NULL OR r.id=?) ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,projectId,caseId,versionId,criterionId,judgeId??null,judgeId??null);
    if(!row)throw new DatasetRevisionConflictError(`No recorded result for case ${caseId} and selected evaluator version`);
    return {skillVersionId:versionId,judgeRunId:String(row.id)};
  }
  const commands={
    createReviewQueue(input:Args<'createReviewQueue'>[0]) { return transaction(now=> {
      if(input.judgeRunIds&&(!input.skillVersionId||Object.keys(input.judgeRunIds).length!==new Set(input.caseIds).size||input.caseIds.some(id=>!Object.hasOwn(input.judgeRunIds!,id)||!input.judgeRunIds![id])))throw new DatasetRevisionConflictError('Explicit recorded results must match every selected case and evaluator');
      const cv=criterion(input.projectId,input.criterionVersionId,input.skillVersionId),id=`revq_${randomUUID()}`,stamp=new Date(now).toISOString();
      run('INSERT INTO review_queues(id,project_id,name,description,created_by_user_id,created_at) VALUES(?,?,?,?,?,?)',id,input.projectId,input.name,input.description??null,input.createdByUserId??null,stamp);
      for(const [position,caseId] of [...new Set(input.caseIds)].entries()) {
        const p=pin(input.projectId,caseId,cv,input.skillVersionId,input.judgeRunIds?.[caseId]);
        run('INSERT INTO review_queue_items(id,project_id,queue_id,case_id,criterion_version_id,skill_version_id,judge_run_id,position,created_at,assignment_key) VALUES(?,?,?,?,?,?,?,?,?,?)',`revqi_${randomUUID()}`,input.projectId,id,caseId,cv,p.skillVersionId,p.judgeRunId,position,stamp,'');
      }
      return commands.getReviewQueueDetail(input.projectId,id)!.queue;
    }); },
    listReviewQueues(projectId:string,opts:Args<'listReviewQueues'>[1]={}) { return all(`${selection} WHERE q.project_id=? AND (? IS NULL OR q.status=?) ORDER BY q.created_at DESC,q.id DESC`,projectId,opts.status??null,opts.status??null).map(queue); },
    getReviewQueueDetail(projectId:string,queueId:string) {
      const row=one(`${selection} WHERE q.project_id=? AND q.id=?`,projectId,queueId);
      return row?{queue:queue(row),items:all('SELECT * FROM review_queue_items WHERE project_id=? AND queue_id=? ORDER BY position,id',projectId,queueId).map(item)}:null;
    },
    getNextPendingQueueItem(projectId:string,queueId:string,opts:Args<'getNextPendingQueueItem'>[2]={}) {
      if(!opts.criterionVersionId) {
        const count=one("SELECT count(DISTINCT criterion_version_id) n FROM review_queue_items WHERE project_id=? AND queue_id=? AND status='pending'",projectId,queueId)!.n;
        if(count>1)throw new AmbiguousProjectSkillError(projectId,count);
      } else criterion(projectId,opts.criterionVersionId);
      const row=one(`SELECT i.* FROM review_queue_items i JOIN review_queues q ON q.id=i.queue_id WHERE q.project_id=? AND q.id=? AND q.status='open' AND i.status='pending' AND (? IS NULL OR i.assigned_to_user_id IS NULL OR i.assigned_to_user_id=?) AND (? IS NULL OR i.criterion_version_id=?) ORDER BY i.position,i.id LIMIT 1`,projectId,queueId,opts.assignedToUserId??null,opts.assignedToUserId??null,opts.criterionVersionId??null,opts.criterionVersionId??null);
      return row?item(row):null;
    },
    addReviewQueueItems(input:Args<'addReviewQueueItems'>[0]) { return transaction(now=> {
      if(!one("SELECT 1 FROM review_queues WHERE project_id=? AND id=? AND status='open'",input.projectId,input.queueId))throw new DatasetRevisionConflictError('Review queue is missing or closed');
      let position=one('SELECT coalesce(max(position)+1,0) n FROM review_queue_items WHERE queue_id=?',input.queueId)!.n;
      const added=[];
      for(const value of input.items) {
        const cv=criterion(input.projectId,value.criterionVersionId,value.skillVersionId),p=pin(input.projectId,value.caseId,cv,value.skillVersionId);
        const row=one('INSERT INTO review_queue_items(id,project_id,queue_id,case_id,criterion_version_id,skill_version_id,judge_run_id,position,created_at,assigned_to_user_id,assignment_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *',`revqi_${randomUUID()}`,input.projectId,input.queueId,value.caseId,cv,p.skillVersionId,p.judgeRunId,position,new Date(now).toISOString(),value.assignedToUserId??null,value.assignedToUserId??'');
        if(row){added.push(item(row));position++;}
      }
      return added;
    }); },
    closeReviewQueue(projectId:string,queueId:string) { return transaction(now=> {
      run("UPDATE review_queues SET status='closed',closed_at=? WHERE project_id=? AND id=? AND status<>'closed'",new Date(now).toISOString(),projectId,queueId);return commands.getReviewQueueDetail(projectId,queueId)?.queue??null;
    }); },
    reopenReviewQueue(projectId:string,queueId:string) { return transaction(()=> {
      run("UPDATE review_queues SET status='open',closed_at=NULL WHERE project_id=? AND id=? AND status<>'open'",projectId,queueId);return commands.getReviewQueueDetail(projectId,queueId)?.queue??null;
    }); },
    suggestReviewQueue(projectId:string,versionId:string,limit:number) {
      const cv=criterion(projectId,undefined,versionId);
      const candidates=all(`SELECT r.* FROM judge_runs r JOIN cases c ON c.id=r.case_id AND c.project_id=r.project_id WHERE r.project_id=? AND r.skill_version_id=? AND c.case_type NOT IN ('gate_candidate','release_evidence')
        AND NOT EXISTS(SELECT 1 FROM verdicts v WHERE v.project_id=r.project_id AND v.case_id=r.case_id AND v.skill_version_id=r.skill_version_id AND v.source IN ('human','adjudicated') AND(v.reviewed_judge_run_id=r.id OR(v.reviewed_judge_run_id IS NULL AND v.created_at>=r.created_at)))
        AND NOT EXISTS(SELECT 1 FROM review_queue_items i JOIN review_queues q ON q.id=i.queue_id WHERE q.project_id=r.project_id AND q.status='open' AND i.status='pending' AND i.judge_run_id=r.id)
        ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,projectId,versionId,REVIEW_CANDIDATE_LIMIT+1);
      return suggestReviewBatch(candidates.map(r=>({caseId:r.case_id,judgeRunId:r.id,verdict:r.verdict,createdAt:r.created_at})),versionId,cv,limit);
    }
  };
  return commands;
}

/** Append a ruling and its task completion in the caller-owned transaction. */
export function recordSqliteQueueReview(db:DatabaseSync,input:RecordVerdictInput,now:number) {
  if(!db.isTransaction)throw new Error('Queue review requires an owned transaction');
  const {one,run}=evaluationDatabase(db),parsedContext=ReviewContextSchema.parse(input.reviewContext);
  const context={...parsedContext,submissionId:parsedContext.submissionId.toLowerCase()};
  if(input.source!=='human')throw new DatasetRevisionConflictError('Only human reviews can complete a review task');
  const task=one(`SELECT i.*,q.status queue_status,r.skill_version_id reviewed_version FROM review_queue_items i JOIN review_queues q ON q.id=i.queue_id
    JOIN judge_runs r ON r.id=? AND r.case_id=i.case_id AND r.project_id=q.project_id JOIN skill_versions v ON v.id=r.skill_version_id AND v.criterion_version_id=i.criterion_version_id
    WHERE i.id=? AND i.project_id=? AND i.case_id=? AND(i.assigned_to_user_id IS NULL OR i.assigned_to_user_id=?) AND(i.judge_run_id IS NULL OR(i.judge_run_id=r.id AND i.skill_version_id=r.skill_version_id)) AND(? IS NULL OR r.skill_version_id=?)`,context.judgeRunId,context.queueItemId,input.projectId,input.caseId,input.actorUserId??null,input.skillVersionId??null,input.skillVersionId??null);
  if(!task)throw new DatasetRevisionConflictError('Review task, assignment or recorded result does not match');
  const existing=one('SELECT * FROM verdicts WHERE review_queue_item_id=? AND review_submission_id=?',context.queueItemId,context.submissionId);
  if(existing) {
    if(canonicalJson(parse(existing.payload))!==canonicalJson(input.payload)||existing.actor_user_id!==(input.actorUserId??null)||existing.reviewed_judge_run_id!==context.judgeRunId)throw new DatasetRevisionConflictError('Review submission ID already used for a different ruling');
    return verdict(existing);
  }
  if(task.queue_status!=='open')throw new DatasetRevisionConflictError('This review queue is closed');
  if(task.status!=='pending')throw new DatasetRevisionConflictError('This review task is already completed');
  const value=VerdictRecordSchema.parse({...input,id:`verdict_${randomUUID()}`,skillVersionId:task.reviewed_version,actorUserId:input.actorUserId??null,externalRunId:null,createdAt:new Date(now).toISOString()});
  const row=one('INSERT INTO verdicts(id,project_id,case_id,skill_version_id,source,actor_user_id,verdict_kind,payload,created_at,review_queue_item_id,reviewed_judge_run_id,review_submission_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *',value.id,value.projectId,value.caseId,value.skillVersionId,'human',value.actorUserId,value.payload.kind,json(value.payload),value.createdAt,context.queueItemId,context.judgeRunId,context.submissionId)!;
  run("UPDATE review_queue_items SET status='completed',completed_at=coalesce(completed_at,?) WHERE id=?",value.createdAt,task.id);
  return verdict(row);
}
