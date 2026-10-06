import type { DatabaseSync,SQLInputValue } from 'node:sqlite';
import { GovernedReviewStreamCommandSchema,type GovernedReviewStreamCommand } from '../../governed-review/contracts.js';
import type { GovernedReviewActor,GovernedBlindTaskViewArtifact } from '../../governed-review/repository.js';
import { GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError,GovernedReviewStreamConflictError,GovernedReviewTransitionConflictError } from '../../governed-review/errors.js';
import { buildBlindTaskViewArtifact } from '../../governed-review/blind-view-artifact.js';
import { verifyExactBlindTaskViewArtifact } from '../../governed-review/projection.js';
import { stableId,taskEventContent } from '../../governed-review/storage-values.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedReviewAccess,governedReviewSubject } from './governed-subject-commands.js';
import { governedBlindViewRowsSql } from './governed-draft-commands.js';
import { sqliteCommand,registerSqliteValidator,type SqliteCommandContext } from './command-context.js';
const initialized=new WeakSet<DatabaseSync>();
const taskViewSql=governedBlindViewRowsSql.replace(' ORDER BY t.serve_order,t.id',' AND t.id=?');
const internalViewKey=`rubrist-internal/view/v1/${'0'.repeat(200)}`;
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
export function initializeGovernedViewValidator(db:DatabaseSync):void {
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_governed_task_view_valid_v1',['governed_task_event_insert'],(reader,taskId,projectId,bytes)=>{
  if(!(bytes instanceof Uint8Array))return false;
  const task=reader.get('SELECT batch_id FROM governed_review_tasks WHERE id=? AND project_id=?',taskId,projectId);if(!task)return false;
  const row=reader.get(taskViewSql,task.batch_id!,projectId,taskId);if(!row)return false;
  return Buffer.from(buildBlindTaskViewArtifact(row).canonicalBytes).equals(bytes);
 });initialized.add(db);
}
function insert(c:SqliteCommandContext,table:'governed_review_batch_events'|'governed_review_task_events',row:Record<string,SQLInputValue>){c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));}
/** Nonsealed transitions; alignment, adjudication and freeze remain staged. */
export function transitionNonsealedGovernedBatch(db:DatabaseSync,actor:GovernedReviewActor,batchId:string,action:'open'|'close_labeling'|'finalize',raw:GovernedReviewStreamCommand,clock=Date.now):string {
 initializeGovernedViewValidator(db);
 const command=GovernedReviewStreamCommandSchema.parse(raw);
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor,true);const batch=c.db.prepare('SELECT * FROM governed_review_batch_states WHERE batch_id=? AND project_id=?').get(batchId,actor.projectId);if(!batch)throw new GovernedReviewNotFoundError();
  const subjectId=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp),requestDigest=governedReviewRequestDigest({batchId,action,command});
  const existing=c.db.prepare('SELECT id,request_digest FROM governed_review_batch_events WHERE batch_id=? AND idempotency_key=?').get(batchId,command.idempotencyKey);
  if(existing){if(existing.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return String(existing.id);}
  if(Number(batch.state_version)!==command.expectedStateVersion)throw new GovernedReviewStreamConflictError({currentState:String(batch.state),currentVersion:Number(batch.state_version)});
  const expected=action==='open'?'draft':action==='close_labeling'?'open':'labeling_closed';
  if(batch.state!==expected)throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:action});
  let eventKind=action==='open'?'open':'labeling_closed',details:unknown={};
  if(action==='close_labeling'){
   const stop=c.db.prepare('SELECT governed_timestamp_v1(sqlite_command_time())>=governed_timestamp_v1(stop_at) AS at_stop FROM governed_review_batches WHERE id=?').get(batchId)!;
   const atStop=stop.at_stop===1;
   const tasks=c.db.prepare('SELECT task_id,state FROM governed_review_task_states WHERE batch_id=? ORDER BY task_id').all(batchId);
   if(!atStop&&tasks.some(t=>!['submitted','deferred'].includes(String(t.state))))throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:action});
   details={activeLabelIds:c.db.prepare('SELECT label_id FROM governed_active_review_labels WHERE batch_id=? ORDER BY label_id').all(batchId).map(r=>String(r.label_id)),deferredTaskIds:tasks.filter(t=>t.state==='deferred').map(t=>String(t.task_id)),expiredTaskIds:atStop?tasks.filter(t=>['assigned','viewed','withdrawn'].includes(String(t.state))).map(t=>String(t.task_id)):[],closedAtFixedStop:atStop};
  } else if(action==='finalize'){
   const items=c.db.prepare('SELECT i.review_item_id,r.resolution_kind FROM governed_review_batch_items i JOIN governed_review_item_resolutions r ON r.batch_item_id=i.id WHERE i.batch_id=? ORDER BY i.draw_position,i.id').all(batchId);
   if(items.every(i=>['single_rater','unanimous','adjudicated'].includes(String(i.resolution_kind)))){eventKind='resolved';details={resolvedReviewItemIds:items.map(i=>String(i.review_item_id))};}
   else if(items.some(i=>['coverage_gap','unresolvable'].includes(String(i.resolution_kind)))){eventKind='incomplete';details={gapReviewItemIds:items.filter(i=>['coverage_gap','unresolvable'].includes(String(i.resolution_kind))).map(i=>String(i.review_item_id))};}
   else throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:'finalize_requires_adjudication'});
  }
  const version=Number(batch.state_version)+1,previous=c.db.prepare('SELECT event_digest FROM governed_review_batch_events WHERE batch_id=? ORDER BY state_version DESC LIMIT 1').get(batchId)?.event_digest??null;
  const basis={actorRoleAtReview:actor.projectRole,actorSubjectId:subjectId,batchId,datasetRevisionId:null,details,eventKind,previousEventDigest:previous,representativeIneligibleReasons:[],representativeOfPopulationId:null,sequence:version,stateVersion:version};
  const id=stableId('grbe',batchId,command.idempotencyKey);
  insert(c,'governed_review_batch_events',{id,project_id:actor.projectId,batch_id:batchId,sequence:version,state_version:version,expected_previous_state_version:command.expectedStateVersion,event_kind:eventKind,actor_subject_id:subjectId,actor_role_at_review:actor.projectRole,representative_ineligible_reasons:'[]',details:JSON.stringify(details),previous_event_digest:previous,event_digest:digest('governed-review-batch-event/v1',basis),idempotency_key:command.idempotencyKey,request_digest:requestDigest,occurred_at:c.timestamp});return id;
 },clock);
}
export function openNonsealedGovernedBatch(db:DatabaseSync,actor:GovernedReviewActor,batchId:string,raw:GovernedReviewStreamCommand,clock=Date.now):string {return transitionNonsealedGovernedBatch(db,actor,batchId,'open',raw,clock);}
export function getOrCreateNonsealedBlindView(db:DatabaseSync,actor:GovernedReviewActor,taskId:string,clock=Date.now):GovernedBlindTaskViewArtifact {
 initializeGovernedViewValidator(db);
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor);
  const task=c.db.prepare('SELECT t.* FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id AND s.project_id=t.project_id WHERE t.id=? AND t.project_id=? AND s.account_user_id=?').get(taskId,actor.projectId,actor.userId);
  if(!task)throw new GovernedReviewNotFoundError();
  const viewed=c.db.prepare("SELECT canonical_view_bytes,view_digest FROM governed_review_task_events WHERE task_id=? AND event_kind='viewed' ORDER BY sequence LIMIT 1").get(taskId);
  if(viewed){const artifact={canonicalBytes:Buffer.from(viewed.canonical_view_bytes as Uint8Array),viewDigest:String(viewed.view_digest)};verifyExactBlindTaskViewArtifact(artifact);return artifact;}
  const state=c.db.prepare('SELECT state,state_version FROM governed_review_task_states WHERE task_id=?').get(taskId)!;
  const batch=c.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(task.batch_id!);
  if(state.state!=='assigned'||state.state_version!==0||batch?.state!=='open')throw new GovernedReviewTransitionConflictError({currentState:String(batch?.state==='open'?state.state:batch?.state),attemptedAction:'view'});
  const row=c.db.prepare(taskViewSql).get(task.batch_id!,actor.projectId,taskId)!;
  const artifact=buildBlindTaskViewArtifact(row),bytes=Buffer.from(artifact.canonicalBytes);
  const basis=taskEventContent({actorRoleAtReview:String(task.reviewer_role_at_review),actorSubjectId:String(task.reviewer_subject_id),eventKind:'viewed',taskId,sequence:1,previousEventDigest:null,canonicalViewBytesBase64:bytes.toString('base64'),viewDigest:artifact.viewDigest,viewContractVersion:'rubrist/governed-blind-task-view/v1',canonicalizationVersion:'rubrist-canonical-json/v1',exposureClass:'provenance',activity:'governed_review'});
  insert(c,'governed_review_task_events',{id:stableId('grte',taskId,'viewed'),project_id:actor.projectId,task_id:taskId,sequence:1,state_version:1,expected_previous_state_version:0,event_kind:'viewed',actor_subject_id:task.reviewer_subject_id!,actor_role_at_review:task.reviewer_role_at_review!,canonical_view_bytes:bytes,view_digest:artifact.viewDigest,view_contract_version:'rubrist/governed-blind-task-view/v1',canonicalization_version:'rubrist-canonical-json/v1',exposure_class:'provenance',activity:'governed_review',event_digest:digest('governed-review-task-event/v1',basis),idempotency_key:internalViewKey,request_digest:governedReviewRequestDigest({taskId,action:'view'}),occurred_at:c.timestamp});
  return {canonicalBytes:bytes,viewDigest:artifact.viewDigest};
 },clock);
}
