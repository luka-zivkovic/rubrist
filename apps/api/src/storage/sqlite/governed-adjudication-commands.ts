import type { DatabaseSync,SQLInputValue,SQLOutputValue } from 'node:sqlite';
import type { GovernedReviewActor } from '../../governed-review/repository.js';
import type { AppendGovernedReviewAdjudicationInput,GovernedAdjudicationProjection } from '../../governed-review/contracts.js';
import { GovernedReviewConflictError,GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError,GovernedReviewStreamConflictError,GovernedReviewTransitionConflictError } from '../../governed-review/errors.js';
import { stableId } from '../../governed-review/storage-values.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedReviewAccess,governedReviewSubject } from './governed-subject-commands.js';
import { sqliteCommand,type SqliteCommandDatabase } from './command-context.js';
function projection(db:SqliteCommandDatabase,row:Record<string,SQLOutputValue>):GovernedAdjudicationProjection{return {adjudicationId:String(row.id),batchId:String(row.batch_id),batchItemId:String(row.batch_item_id),chainVersion:Number(row.chain_version),predecessorAdjudicationId:row.supersedes_adjudication_id===null?null:String(row.supersedes_adjudication_id),decision:row.decision as GovernedAdjudicationProjection['decision'],rationale:String(row.rationale),basis:String(row.basis),correctionReason:row.correction_reason===null?null:String(row.correction_reason),consideredLabelIds:db.prepare('SELECT label_id FROM governed_review_adjudication_labels WHERE adjudication_id=? ORDER BY label_id').all(row.id!).map(l=>String(l.label_id)),createdAt:new Date(String(row.created_at)).toISOString()};}
export function appendNonsealedGovernedAdjudication(db:DatabaseSync,actor:GovernedReviewActor,batchId:string,itemId:string,input:AppendGovernedReviewAdjudicationInput,clock=Date.now):GovernedAdjudicationProjection {
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor,true);
  const batch=c.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=? AND project_id=?').get(batchId,actor.projectId);if(!batch)throw new GovernedReviewNotFoundError();
  const item=c.db.prepare('SELECT id FROM governed_review_batch_items WHERE batch_id=? AND project_id=? AND (id=? OR review_item_id=?)').get(batchId,actor.projectId,itemId,itemId);if(!item)throw new GovernedReviewNotFoundError();
  const batchItemId=String(item.id),subjectId=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp),requestDigest=governedReviewRequestDigest({batchId,itemId:batchItemId,input});
  const replay=c.db.prepare('SELECT * FROM governed_review_adjudications WHERE batch_item_id=? AND idempotency_key=?').get(batchItemId,input.idempotencyKey);
  if(replay){if(replay.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return projection(c.db,replay);}
  if(batch.state!=='adjudicating')throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:batch.state==='frozen'?'correct_adjudication_without_successor_materialization':'adjudicate'});
  const head=c.db.prepare('SELECT id,chain_version FROM governed_review_adjudications WHERE batch_item_id=? ORDER BY chain_version DESC LIMIT 1').get(batchItemId),headId=head?String(head.id):null,version=Number(head?.chain_version??0);
  if(headId!==input.expectedHeadAdjudicationId)throw new GovernedReviewStreamConflictError({currentState:String(batch.state),currentVersion:version});
  if((head&&!input.correctionReason)||(!head&&input.correctionReason!=null))throw new GovernedReviewConflictError('governed_review_transition_conflict','Only adjudication corrections require a non-empty correction reason');
  const labels=c.db.prepare('SELECT label_count,label_set FROM governed_review_item_label_sets WHERE batch_item_id=?').get(batchItemId)!;
  const id=stableId('gra',batchItemId,input.idempotencyKey),chainVersion=version+1,labelSetDigest=governedJsonTextDigest('governed-review-item-label-set/v1',String(labels.label_set));
  const basis={adjudicatorRoleAtReview:actor.projectRole,adjudicatorSubjectId:subjectId,basis:input.basis,batchId,batchItemId,chainVersion,consideredLabelCount:Number(labels.label_count),consideredLabelSetDigest:labelSetDigest,correctionReason:input.correctionReason??null,decision:input.decision,rationale:input.rationale,supersedesAdjudicationId:headId};
  const row:Record<string,SQLInputValue>={id,project_id:actor.projectId,batch_id:batchId,batch_item_id:batchItemId,chain_version:chainVersion,expected_previous_chain_version:version,supersedes_adjudication_id:headId,adjudicator_subject_id:subjectId,adjudicator_role_at_review:actor.projectRole,decision:input.decision,rationale:input.rationale,basis:input.basis,correction_reason:input.correctionReason??null,considered_label_count:Number(labels.label_count),considered_label_set_digest:labelSetDigest,content_digest:governedJsonTextDigest('governed-review-adjudication/v1',JSON.stringify(basis)),idempotency_key:input.idempotencyKey,request_digest:requestDigest,created_at:c.timestamp,created_command_token:c.token};
  c.db.prepare(`INSERT INTO governed_review_adjudications(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  return projection(c.db,c.db.prepare('SELECT * FROM governed_review_adjudications WHERE id=?').get(id)!);
 },clock);
}
