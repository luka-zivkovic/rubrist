import type { DatabaseSync,SQLInputValue,SQLOutputValue } from 'node:sqlite';
import type { GovernedReviewActor } from '../../governed-review/repository.js';
import type { AppendGovernedReviewAlignmentEventInput,GovernedAlignmentEventProjection } from '../../governed-review/contracts.js';
import { GovernedReviewForbiddenError,GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError,GovernedReviewStreamConflictError,GovernedReviewTransitionConflictError } from '../../governed-review/errors.js';
import { stableId } from '../../governed-review/storage-values.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedReviewAccess,governedReviewSubject } from './governed-subject-commands.js';
import { sqliteCommand } from './command-context.js';
function projection(row:Record<string,SQLOutputValue>):GovernedAlignmentEventProjection{return {alignmentEventId:String(row.id),batchId:String(row.batch_id),sequence:Number(row.sequence),kind:row.event_kind as GovernedAlignmentEventProjection['kind'],content:String(row.content),proposedInstructionVersionId:row.proposed_instruction_version_id===null?null:String(row.proposed_instruction_version_id),visibleLabelCount:Number(row.visible_label_count),occurredAt:new Date(String(row.occurred_at)).toISOString()};}
export function appendNonsealedGovernedAlignment(db:DatabaseSync,actor:GovernedReviewActor,batchId:string,input:AppendGovernedReviewAlignmentEventInput,clock=Date.now):GovernedAlignmentEventProjection {
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor);
  const batch=c.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=? AND project_id=?').get(batchId,actor.projectId);if(!batch)throw new GovernedReviewNotFoundError();
  const subjectId=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp);
  if(actor.projectRole!=='owner'&&!c.db.prepare('SELECT 1 FROM governed_review_tasks WHERE batch_id=? AND reviewer_subject_id=? LIMIT 1').get(batchId,subjectId))throw new GovernedReviewForbiddenError();
  const requestDigest=governedReviewRequestDigest({batchId,input});
  const replay=c.db.prepare('SELECT * FROM governed_review_alignment_events WHERE batch_id=? AND idempotency_key=?').get(batchId,input.idempotencyKey);
  if(replay){if(replay.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return projection(replay);}
  if(batch.state!=='alignment_open')throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:'append_alignment'});
  const prior=c.db.prepare('SELECT sequence,event_digest,event_kind FROM governed_review_alignment_events WHERE batch_id=? ORDER BY sequence DESC LIMIT 1').get(batchId),version=Number(prior?.sequence??0);
  if(version!==input.expectedAlignmentVersion)throw new GovernedReviewStreamConflictError({currentState:'alignment_open',currentVersion:version});
  if(prior?.event_kind==='closed')throw new GovernedReviewTransitionConflictError({currentState:'alignment_closed',attemptedAction:'append_alignment'});
  const labels=c.db.prepare('SELECT label_count,label_set FROM governed_review_batch_label_sets WHERE batch_id=?').get(batchId)!;
  const id=stableId('grae',batchId,input.idempotencyKey),sequence=version+1,labelSetDigest=governedJsonTextDigest('governed-review-label-set/v1',String(labels.label_set));
  const basis={actorRoleAtReview:actor.projectRole,actorSubjectId:subjectId,batchId,content:input.content,eventKind:input.kind,previousEventDigest:prior?.event_digest??null,proposedInstructionVersionId:input.proposedInstructionVersionId??null,sequence,visibleLabelCount:Number(labels.label_count),visibleLabelSetDigest:labelSetDigest};
  const row:Record<string,SQLInputValue>={id,project_id:actor.projectId,batch_id:batchId,sequence,expected_previous_sequence:version,event_kind:input.kind,actor_subject_id:subjectId,actor_role_at_review:actor.projectRole,content:input.content,proposed_instruction_version_id:input.proposedInstructionVersionId??null,visible_label_count:Number(labels.label_count),visible_label_set_digest:labelSetDigest,previous_event_digest:prior?.event_digest??null,event_digest:governedJsonTextDigest('governed-review-alignment-event/v1',JSON.stringify(basis)),idempotency_key:input.idempotencyKey,request_digest:requestDigest,occurred_at:c.timestamp,created_command_token:c.token};
  c.db.prepare(`INSERT INTO governed_review_alignment_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  return projection(c.db.prepare('SELECT * FROM governed_review_alignment_events WHERE id=?').get(id)!);
 },clock);
}
