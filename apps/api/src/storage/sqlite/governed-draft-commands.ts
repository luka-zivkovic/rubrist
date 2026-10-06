import type { DatabaseSync,SQLInputValue } from 'node:sqlite';
import { CreateGovernedReviewBatchInputSchema,type CreateGovernedReviewBatchInput } from '../../governed-review/contracts.js';
import type { GovernedReviewActor } from '../../governed-review/repository.js';
import { GovernedReviewConflictError,GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError } from '../../governed-review/errors.js';
import { stableId } from '../../governed-review/storage-values.js';
import { executeGovernedReviewSelection } from '../../governed-review/selection.js';
import { buildBlindTaskViewArtifact } from '../../governed-review/blind-view-artifact.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedReviewAccess,governedReviewSubject } from './governed-subject-commands.js';
import { materializeNonsealedReviewItem } from './governed-review-items.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedTimestamp } from './governed-timestamp.js';
import { sqliteCommand,registerSqliteValidator } from './command-context.js';
const initialized=new WeakSet<DatabaseSync>();
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
export const governedBlindViewRowsSql=`SELECT t.id task_id,t.batch_id,t.serve_order,b.criterion_version_id,b.instruction_version_id,i.review_payload_snapshot,v.title,v.instructions,v.failure_code_guidance,v.content_digest instruction_digest,c.criterion_id,c.name criterion_name,c.definition criterion_definition,c.criterion_digest FROM governed_review_tasks t JOIN governed_review_batches b ON b.id=t.batch_id JOIN governed_review_batch_items bi ON bi.id=t.batch_item_id JOIN governed_review_items i ON i.id=bi.review_item_id JOIN review_instruction_versions v ON v.id=b.instruction_version_id JOIN criterion_versions c ON c.id=b.criterion_version_id WHERE t.batch_id=? AND t.project_id=? ORDER BY t.serve_order,t.id`;
export function initializeGovernedDraftValidator(db:DatabaseSync):void {
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_governed_batch_views_valid_v1',['governed_batch_finalize'],(reader,batchId,projectId)=>{
  for(const row of reader.iterate(governedBlindViewRowsSql,batchId,projectId))buildBlindTaskViewArtifact(row);
  return true;
 });initialized.add(db);
}
function translate(selection:CreateGovernedReviewBatchInput['selection'],aliases:Map<string,string>){
 const id=(value:string)=>aliases.get(value)??value;
 if(selection.method==='stratified_random')return {...selection,strata:selection.strata.map(s=>({...s,sourceItemIds:s.sourceItemIds.map(id)}))};
 if('selectedSourceItemIds' in selection)return {...selection,selectedSourceItemIds:selection.selectedSourceItemIds.map(id)};
 return selection;
}
/** Internal draft builder; repository projection and other source ports follow separately. */
export function createNonsealedGovernedDraft(db:DatabaseSync,actor:GovernedReviewActor,raw:CreateGovernedReviewBatchInput,clock=Date.now):string {
 initializeGovernedDraftValidator(db);const input=CreateGovernedReviewBatchInputSchema.parse(raw);
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor,true);
  const requestDigest=governedReviewRequestDigest(input),existing=c.db.prepare('SELECT id,request_digest FROM governed_review_batches WHERE project_id=? AND idempotency_key=?').get(actor.projectId,input.idempotencyKey);
  if(existing){if(existing.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return String(existing.id);}
  if(input.source.kind!=='dataset_revision'||input.roleIntent==='sealed_validation')throw new GovernedReviewConflictError('governed_review_transition_conflict','This draft source requires its complete governed port');
  const stopAt=governedTimestamp(input.fixedStopAt);if(stopAt<=governedTimestamp(c.timestamp))throw new GovernedReviewConflictError('governed_review_transition_conflict','The governed review fixed stop must be in the future');
  const creator=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp);
  const instruction=c.db.prepare('SELECT * FROM review_instruction_versions WHERE id=? AND project_id=?').get(input.instructionVersionId,actor.projectId);
  if(!instruction)throw new GovernedReviewNotFoundError();
  const reviewers=input.reviewerUserIds.map(userId=>({id:governedReviewSubject(db,actor.projectId,userId,c.timestamp),role:String(c.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(actor.projectId,userId)!.role)}));
  const revision=c.db.prepare("SELECT * FROM dataset_revisions WHERE project_id=? AND id=? AND role=? AND role<>'sealed_validation' AND source_kind<>'analysis_population'").get(actor.projectId,input.source.revisionId,input.roleIntent);
  if(!revision)throw new GovernedReviewNotFoundError();
  const sources=c.db.prepare('SELECT id FROM dataset_revision_items WHERE project_id=? AND revision_id=? ORDER BY position,governed_utf16_sort_key_v1(id)').all(actor.projectId,input.source.revisionId);
  if(!sources.length||sources.length!==Number(revision.item_count))throw new GovernedReviewConflictError('governed_review_transition_conflict','The immutable source population must have its complete nonempty frame');
  const frame=sources.map(row=>materializeNonsealedReviewItem(c,actor.projectId,String(revision.id),String(row.id),creator));
  const aliases=new Map<string,string>();for(const item of frame){aliases.set(item.id,item.id);aliases.set(item.sourceId,item.id);}
  const selection=executeGovernedReviewSelection({frame:frame.map(({id,digest})=>({id,digest})),selection:translate(input.selection,aliases)}),byId=new Map(frame.map(item=>[item.id,item]));
  const stratumByItem=new Map<string,string>();for(const stratum of selection.strata)for(const id of stratum.selectedItemIds)stratumByItem.set(id,stratum.key);
  const probabilities=new Map(selection.strata.map(s=>[s.key,s.fixedBudget/s.populationSize]));
  const members=selection.selected.map((item,drawPosition)=>{const stratumKey=stratumByItem.get(item.id)??null,inclusionProbability=selection.method==='simple_random'?selection.selected.length/frame.length:stratumKey?probabilities.get(stratumKey)!:null;return {drawPosition,frameMemberDigest:item.digest,inclusionProbability,reviewItemId:item.id,samplingWeight:inclusionProbability===null?null:1/inclusionProbability,stratumKey};});
  const strata=selection.strata.map(s=>({key:s.key,definition:s.definition,populationSize:s.populationSize,membershipDigest:s.membershipDigest,inclusionProbability:s.fixedBudget/s.populationSize,weight:1/(s.fixedBudget/s.populationSize),fixedBudget:s.fixedBudget,drawItemDigests:s.selectedItemIds.map(id=>byId.get(id)!.digest),drawDigest:s.drawDigest}));
  const batchId=stableId('grb',actor.projectId,input.idempotencyKey),drawDigest=digest('governed-review-draw/v1',members);
  const basis={criterionVersionId:String(instruction.criterion_version_id),custodianRoleAtReview:null,custodianSubjectId:null,drawDigest,drawExecutedBy:selection.drawExecutor,evaluatorBlind:true,fixedBudget:selection.selected.length,instructionVersionId:input.instructionVersionId,peerBlindUntilLabelingClosed:true,populationCollectionProvenance:{kind:'dataset_revision',revisionDigest:String(revision.revision_digest),provenanceLevel:String(revision.provenance_level),sourceKind:String(revision.source_kind)},populationDefinition:{kind:'immutable_dataset_revision',revisionId:String(revision.id),role:input.roleIntent},populationDigest:String(revision.content_digest),populationId:'dataset-revision:'+revision.id,populationSize:frame.length,requiredLabelsPerItem:reviewers.length,rngVersion:selection.rngVersion,roleIntent:input.roleIntent,selectionAlgorithmVersion:selection.algorithmVersion,selectionMethod:selection.method,selectionSeed:selection.seed,separationOfDutiesRequired:false,serveOrderSeed:selection.serveOrder.seed,serveOrderVersion:selection.serveOrder.version,sourcePopulationId:String(revision.id),sourcePopulationKind:'dataset_revision',stateMachineVersion:'governed-review-state/v1',stopAt,stoppingRule:'fixed',strata,windowEnd:null,windowStart:null};
  function insert(table:'governed_review_batches'|'governed_review_batch_items'|'governed_review_tasks',row:Record<string,SQLInputValue>){c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));}
  const row:Record<string,SQLInputValue>={id:batchId,project_id:actor.projectId,content_digest:digest('governed-review-batch/v1',basis),idempotency_key:input.idempotencyKey,request_digest:requestDigest,created_by_subject_id:creator,created_at:c.timestamp,created_command_token:c.token};
  for(const [key,value] of Object.entries(basis))row[key.replace(/[A-Z]/g,ch=>'_'+ch.toLowerCase())]=typeof value==='boolean'?Number(value):value!==null&&typeof value==='object'?JSON.stringify(value):value;
  insert('governed_review_batches',row);
  for(const member of members){
   const batchItemId=stableId('grbi',batchId,member.reviewItemId),servePosition=selection.serveOrder.positions[member.drawPosition]!;
   insert('governed_review_batch_items',{id:batchItemId,project_id:actor.projectId,batch_id:batchId,review_item_id:member.reviewItemId,draw_position:member.drawPosition,serve_position:servePosition,frame_member_digest:member.frameMemberDigest,stratum_key:member.stratumKey,inclusion_probability:member.inclusionProbability===null?null:String(member.inclusionProbability),sampling_weight:member.samplingWeight===null?null:String(member.samplingWeight),content_digest:digest('governed-review-batch-item/v1',{batchId,...member,servePosition}),created_at:c.timestamp});
   for(const reviewer of reviewers){const taskBasis={batchId,batchItemId,reviewerRoleAtReview:reviewer.role,reviewerSubjectId:reviewer.id,serveOrder:servePosition};
    insert('governed_review_tasks',{id:stableId('grt',batchId,batchItemId,reviewer.id),project_id:actor.projectId,batch_id:batchId,batch_item_id:batchItemId,reviewer_subject_id:reviewer.id,reviewer_role_at_review:reviewer.role,serve_order:servePosition,content_digest:digest('governed-review-task/v1',taskBasis),idempotency_key:`assignment:${batchId}:${batchItemId}:${reviewer.id}`,request_digest:governedReviewRequestDigest(taskBasis),created_at:c.timestamp});
   }
  }
  c.db.prepare('INSERT INTO governed_review_batch_finalizations VALUES(?,?,?)').run(batchId,actor.projectId,c.token);
  return batchId;
 },clock);
}
