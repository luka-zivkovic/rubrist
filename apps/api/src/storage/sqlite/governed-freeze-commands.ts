import type { DatabaseSync,SQLInputValue } from 'node:sqlite';
import type { GovernedReviewActor } from '../../governed-review/repository.js';
import { GovernedReviewStreamCommandSchema,type GovernedReviewStreamCommand } from '../../governed-review/contracts.js';
import { GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError,GovernedReviewStreamConflictError,GovernedReviewTransitionConflictError } from '../../governed-review/errors.js';
import { stableId } from '../../governed-review/storage-values.js';
import { assertBlindProjectionSafe } from '../../governed-review/projection.js';
import { datasetRevisionContentDigest,datasetRevisionDigest,datasetRevisionItemDigest } from '../../lib/dataset-revision.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedReviewAccess,governedReviewSubject } from './governed-subject-commands.js';
import { initializeGovernedViewValidator } from './governed-view-commands.js';
import { sqliteCommand } from './command-context.js';
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
/** Internal nonsealed materialization; the repository projection is loaded later. */
export function freezeNonsealedGovernedTruth(db:DatabaseSync,actor:GovernedReviewActor,batchId:string,raw:GovernedReviewStreamCommand,clock=Date.now):string {
 initializeGovernedViewValidator(db);const command=GovernedReviewStreamCommandSchema.parse(raw);
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor,true);
  const batch=c.db.prepare('SELECT b.*,s.state,s.state_version FROM governed_review_batches b JOIN governed_review_batch_states s ON s.batch_id=b.id WHERE b.id=? AND b.project_id=?').get(batchId,actor.projectId);if(!batch)throw new GovernedReviewNotFoundError();
  const subjectId=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp),requestDigest=governedReviewRequestDigest({batchId,action:'freeze',command});
  const replay=c.db.prepare('SELECT request_digest,dataset_revision_id FROM governed_review_batch_events WHERE batch_id=? AND idempotency_key=?').get(batchId,command.idempotencyKey);
  if(replay){if(replay.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return String(replay.dataset_revision_id);}
  if(batch.state_version!==command.expectedStateVersion)throw new GovernedReviewStreamConflictError({currentState:String(batch.state),currentVersion:Number(batch.state_version)});
  if(batch.state!=='resolved'||!['analysis_authoring','iterative_development'].includes(String(batch.role_intent))||batch.source_population_kind!=='dataset_revision')throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:'freeze'});
  const members=c.db.prepare('SELECT bi.id batch_item_id,bi.draw_position,ri.*,res.resolution_kind,res.resolved_label,res.adjudication_id FROM governed_review_batch_items bi JOIN governed_review_items ri ON ri.id=bi.review_item_id JOIN governed_review_item_resolutions res ON res.batch_item_id=bi.id WHERE bi.batch_id=? ORDER BY bi.draw_position,bi.id').all(batchId);
  if(members.length!==Number(batch.fixed_budget)||members.some(m=>!m.resolved_label))throw new GovernedReviewTransitionConflictError({currentState:String(batch.state),attemptedAction:'freeze_incomplete'});
  const revisionId=stableId('dsr',batchId,'governed-freeze');
  const source=c.db.prepare('SELECT source_dataset_id FROM dataset_revisions WHERE id=?').get(batch.source_population_id!);
  const items=members.map(m=>{
   const batchItemId=String(m.batch_item_id),truthLinkId=stableId('gdtl',revisionId,batchItemId),payload=JSON.parse(String(m.review_payload_snapshot));assertBlindProjectionSafe(payload);
   const provenance={kind:'dataset_claim',sourceId:truthLinkId,verdictIds:[],actorUserIds:[],basis:`Non-authoritative receipt-v1 compatibility projection. Authoritative governed provenance is governed_dataset_truth_links ${truthLinkId}.`};
   const labelIds=c.db.prepare('SELECT label_id FROM governed_active_review_labels WHERE batch_item_id=? ORDER BY label_id').all(batchItemId).map(l=>String(l.label_id));
   const itemDigest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(m.input_digest)},redactedPayload:payload,referenceLabel:String(m.resolved_label),expectedFailStep:null,reviewProvenance:provenance,note:null});
   return {id:stableId('dsri',revisionId,batchItemId),batchItemId,position:Number(m.draw_position),payload,provenance,labelIds,itemDigest,inputDigest:String(m.input_digest),referenceLabel:String(m.resolved_label),resolutionKind:String(m.resolution_kind),adjudicationId:m.adjudication_id===null?null:String(m.adjudication_id),truthLinkId};
  });
  const insert=(table:string,row:Record<string,SQLInputValue>)=>c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  const digests=items.map(i=>i.itemDigest);
  insert('dataset_revisions',{id:revisionId,project_id:actor.projectId,series_id:'governed-review:'+batchId,revision_number:1,source_dataset_id:source?.source_dataset_id??null,parent_revision_id:null,role:batch.role_intent!,source_kind:'collection_snapshot',identity_basis:'input-identity/v1',content_digest:datasetRevisionContentDigest(digests),revision_digest:datasetRevisionDigest({role:batch.role_intent as 'analysis_authoring'|'iterative_development',itemDigests:digests}),item_count:items.length,provenance_level:'governed_blind',created_by_user_id:actor.userId,idempotency_key:'governed-freeze:'+batchId,criterion_version_id:batch.criterion_version_id!,created_at:c.timestamp});
  for(const item of items){
   insert('dataset_revision_items',{id:item.id,revision_id:revisionId,project_id:actor.projectId,position:item.position,input_digest:item.inputDigest,item_digest:item.itemDigest,payload_snapshot:JSON.stringify(item.payload),reference_label:item.referenceLabel,reference_fail_step:null,reference_provenance:JSON.stringify(item.provenance),note:null,created_at:c.timestamp});
   const sourceKind=item.resolutionKind==='adjudicated'?'adjudication':'governed_labels',labelIds=sourceKind==='governed_labels'?item.labelIds:[];
   const basis={adjudicationId:item.adjudicationId,batchItemId:item.batchItemId,criterionVersionId:String(batch.criterion_version_id),datasetRevisionId:revisionId,datasetRevisionItemId:item.id,governedLabelIds:labelIds,importedTruthId:null,resolutionKind:item.resolutionKind,resolvedLabel:item.referenceLabel,sourceKind,supportingLabelCount:item.labelIds.length};
   insert('governed_dataset_truth_links',{id:item.truthLinkId,project_id:actor.projectId,dataset_revision_id:revisionId,dataset_revision_item_id:item.id,criterion_version_id:batch.criterion_version_id!,source_kind:sourceKind,batch_item_id:item.batchItemId,governed_label_ids:JSON.stringify(labelIds),adjudication_id:item.adjudicationId,imported_truth_id:null,resolution_kind:item.resolutionKind,resolved_label:item.referenceLabel,supporting_label_count:item.labelIds.length,content_digest:digest('governed-dataset-truth-link/v1',basis),idempotency_key:`truth-link:${batchId}:${item.batchItemId}`,request_digest:governedReviewRequestDigest(basis),created_at:c.timestamp,created_command_token:c.token});
  }
  insert('dataset_exposure_events',{id:stableId('dse',revisionId,'created'),project_id:actor.projectId,revision_id:revisionId,kind:'created',exposure_class:'lineage',activity:'revision_create',subject_kind:'person',subject_id:subjectId,actor_user_id:actor.userId,evidence_ref_kind:'governed_review_batch',evidence_ref_id:batchId,reason:'Governed truth freeze',details:JSON.stringify({batchId,evidenceClass:'governed_blind'}),idempotency_key:'governed-freeze-created:'+batchId,occurred_at:c.timestamp});
  const reasons=c.db.prepare('SELECT reason FROM governed_review_representative_reasons WHERE batch_id=? ORDER BY reason').all(batchId).map(r=>String(r.reason)),populationId=reasons.length?null:String(batch.population_id),sequence=Number(batch.state_version)+1;
  const previous=c.db.prepare('SELECT event_digest FROM governed_review_batch_events WHERE batch_id=? ORDER BY state_version DESC LIMIT 1').get(batchId)!.event_digest!;
  const details={materializedItemCount:items.length,resolutionKinds:items.map(i=>i.resolutionKind)};
  const basis={actorRoleAtReview:actor.projectRole,actorSubjectId:subjectId,batchId,datasetRevisionId:revisionId,details,eventKind:'frozen',previousEventDigest:previous,representativeIneligibleReasons:reasons,representativeOfPopulationId:populationId,sequence,stateVersion:sequence};
  insert('governed_review_batch_events',{id:stableId('grbe',batchId,command.idempotencyKey),created_command_token:c.token,project_id:actor.projectId,batch_id:batchId,sequence,state_version:sequence,expected_previous_state_version:command.expectedStateVersion,event_kind:'frozen',actor_subject_id:subjectId,actor_role_at_review:actor.projectRole,dataset_revision_id:revisionId,representative_of_population_id:populationId,representative_ineligible_reasons:JSON.stringify(reasons),details:JSON.stringify(details),previous_event_digest:previous,event_digest:digest('governed-review-batch-event/v1',basis),idempotency_key:command.idempotencyKey,request_digest:requestDigest,occurred_at:c.timestamp});
  insert('dataset_revision_finalizations',{revision_id:revisionId,project_id:actor.projectId});return revisionId;
 },clock);
}
