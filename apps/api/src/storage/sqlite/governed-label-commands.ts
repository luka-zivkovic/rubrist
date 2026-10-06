import { governedEvidenceCommand,checkGovernedSeparation } from './governed-capability-commands.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { GovernedReviewActor, GovernedTaskAction } from '../../governed-review/repository.js';
import type { GovernedTaskMutationProjection } from '../../governed-review/contracts.js';
import { GovernedReviewLabelAlreadyRevealedError, GovernedReviewConflictError, GovernedReviewIdempotencyConflictError, GovernedReviewNotFoundError, GovernedReviewStreamConflictError, GovernedReviewTransitionConflictError } from '../../governed-review/errors.js';
import { stableId, taskEventContent } from '../../governed-review/storage-values.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { initializeGovernedViewValidator } from './governed-view-commands.js';
import { governedReviewAccess } from './governed-subject-commands.js';
import { sqliteCommand, type SqliteCommandDatabase } from './command-context.js';
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
function insert(db:SqliteCommandDatabase,table:'governed_review_labels'|'governed_review_task_events',row:Record<string,SQLInputValue>){db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));}
function projection(db:SqliteCommandDatabase,taskId:string):GovernedTaskMutationProjection {
 const row=db.prepare('SELECT state,state_version FROM governed_review_task_states WHERE task_id=?').get(taskId)!;
 const active=db.prepare('SELECT label_id FROM governed_active_review_labels WHERE task_id=?').get(taskId);
 return {taskId,state:String(row.state) as GovernedTaskMutationProjection['state'],stateVersion:Number(row.state_version),activeLabelId:active?String(active.label_id):null};
}
/** Nonsealed actions; the batch stage guard excludes post-barrier revelations. */
export function appendNonsealedGovernedTaskAction(db:DatabaseSync,actor:GovernedReviewActor,taskId:string,action:GovernedTaskAction,clock=Date.now):GovernedTaskMutationProjection {
 if(action.input.idempotencyKey.length<1||action.input.idempotencyKey.length>200)throw new GovernedReviewConflictError('governed_review_transition_conflict','Task action idempotency keys must remain in the public 1-200 character namespace');
 initializeGovernedViewValidator(db);
 return governedEvidenceCommand(db,c=>{
  governedReviewAccess(db,actor);
  const task=c.db.prepare('SELECT t.* FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id AND s.project_id=t.project_id WHERE t.id=? AND t.project_id=? AND s.account_user_id=?').get(taskId,actor.projectId,actor.userId);
  if(!task)throw new GovernedReviewNotFoundError();
  const failed=checkGovernedSeparation(db,c,String(task.batch_id),'batch_open',[String(task.reviewer_subject_id)],action.input.idempotencyKey);if(failed)return failed;
  const input=action.input,requestDigest=governedReviewRequestDigest({taskId,action});
  const replay=c.db.prepare('SELECT request_digest FROM governed_review_task_events WHERE task_id=? AND idempotency_key=?').get(taskId,input.idempotencyKey);
  if(replay){if(replay.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return projection(c.db,taskId);}
  const current=projection(c.db,taskId);
  if(current.stateVersion!==input.expectedStreamVersion)throw new GovernedReviewStreamConflictError({currentState:current.state,currentVersion:current.stateVersion});
  if(action.kind==='withdraw_label'&&current.activeLabelId===action.input.labelId&&c.db.prepare('SELECT 1 FROM governed_review_alignment_event_labels WHERE label_id=? UNION ALL SELECT 1 FROM governed_review_adjudication_labels WHERE label_id=? LIMIT 1').get(action.input.labelId,action.input.labelId))throw new GovernedReviewLabelAlreadyRevealedError();
  const batch=c.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(task.batch_id!)!;
  const valid=action.kind==='defer'?current.state==='viewed':action.kind==='resume'?current.state==='deferred':action.kind==='withdraw_label'?current.state==='submitted'&&current.activeLabelId===action.input.labelId:['viewed','withdrawn'].includes(current.state);
  if(batch.state!=='open'||!valid)throw new GovernedReviewTransitionConflictError({currentState:batch.state!=='open'?String(batch.state):current.state,attemptedAction:action.kind});
  const sequence=current.stateVersion+1,subjectId=String(task.reviewer_subject_id);
  const priorDigest=c.db.prepare('SELECT event_digest FROM governed_review_task_events WHERE task_id=? ORDER BY state_version DESC LIMIT 1').get(taskId)?.event_digest??null;
  let eventKind:string,labelId:string|null=null,reason:string|null=null;
  if(action.kind==='defer'){eventKind='deferred';reason=action.input.reason;}
  else if(action.kind==='resume'){eventKind='resumed';reason=action.input.reason??null;}
  else if(action.kind==='withdraw_label'){eventKind='label_withdrawn';labelId=action.input.labelId;reason=action.input.reason;}
  else {
   eventKind='label_submitted';labelId=stableId('grl',taskId,input.idempotencyKey);
   const prior=c.db.prepare("SELECT l.id,l.attempt FROM governed_review_labels l JOIN governed_review_task_events e ON e.label_id=l.id WHERE l.task_id=? AND e.event_kind='label_withdrawn' ORDER BY e.state_version DESC LIMIT 1").get(taskId);
   const attempt=prior?Number(prior.attempt)+1:1,replacesLabelId=prior?String(prior.id):null;
   const basis={attempt,blindViewDigest:action.input.viewDigest,failureCodes:action.input.failureCodes,label:action.input.label,rationale:action.input.rationale,replacesLabelId,reviewerSubjectId:subjectId,taskId};
   insert(c.db,'governed_review_labels',{id:labelId,project_id:actor.projectId,task_id:taskId,reviewer_subject_id:subjectId,attempt,label:action.input.label,rationale:action.input.rationale,failure_codes:JSON.stringify(action.input.failureCodes),blind_view_digest:action.input.viewDigest,replaces_label_id:replacesLabelId,content_digest:digest('governed-review-label/v1',basis),idempotency_key:input.idempotencyKey,request_digest:requestDigest,created_at:c.timestamp,created_command_token:c.token});
  }
  const basis=taskEventContent({actorRoleAtReview:String(task.reviewer_role_at_review),actorSubjectId:subjectId,eventKind,labelId,reason,taskId,sequence,previousEventDigest:priorDigest===null?null:String(priorDigest)});
  insert(c.db,'governed_review_task_events',{id:stableId('grte',taskId,input.idempotencyKey),project_id:actor.projectId,task_id:taskId,sequence,state_version:sequence,expected_previous_state_version:current.stateVersion,event_kind:eventKind,actor_subject_id:subjectId,actor_role_at_review:task.reviewer_role_at_review!,label_id:labelId,reason,previous_event_digest:priorDigest,event_digest:digest('governed-review-task-event/v1',basis),idempotency_key:input.idempotencyKey,request_digest:requestDigest,occurred_at:c.timestamp});
  return projection(c.db,taskId);
 },clock);
}
