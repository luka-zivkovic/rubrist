import type { DatabaseSync,SQLInputValue,SQLOutputValue } from 'node:sqlite';
import type { GovernedReviewActor } from '../../governed-review/repository.js';
import { CreateSealedReviewIntakeInputSchema,type CreateSealedReviewIntakeInput,type GovernedSealedIntakeReceipt } from '../../governed-review/contracts.js';
import { GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError,GovernedReviewSealedOverlapError } from '../../governed-review/errors.js';
import { stableId } from '../../governed-review/storage-values.js';
import { projectGovernedReviewPayload } from '../../governed-review/projection.js';
import { datasetInputIdentity } from '../../lib/dataset-revision.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedTimestamp } from './governed-timestamp.js';
import { governedReviewAccess,governedReviewSubject } from './governed-subject-commands.js';
import { sqliteCommand } from './command-context.js';
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
function receipt(row:Record<string,SQLOutputValue>):GovernedSealedIntakeReceipt {const definition=JSON.parse(String(row.population_definition));return {intakeId:String(row.id),protection:'sealed',populationDefinition:typeof definition?.definition==='string'?definition.definition:'Protected sealed intake',itemCount:Number(row.frame_count),frameDigest:String(row.frame_digest),predecessorRevisionId:row.predecessor_revision_id===null?null:String(row.predecessor_revision_id),createdAt:new Date(String(row.created_at)).toISOString()};}
export function createGovernedSealedIntake(db:DatabaseSync,actor:GovernedReviewActor,raw:CreateSealedReviewIntakeInput,clock=Date.now):GovernedSealedIntakeReceipt {
 const input=CreateSealedReviewIntakeInputSchema.parse(raw);
 return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor,true);const requestDigest=governedReviewRequestDigest(input);
  const replay=c.db.prepare('SELECT * FROM governed_sealed_intake_populations WHERE project_id=? AND idempotency_key=?').get(actor.projectId,input.idempotencyKey);
  if(replay){if(replay.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return receipt(replay);}
  const custodian=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp),id=stableId('grsip',actor.projectId,input.idempotencyKey);
  const populationDefinition={definition:input.populationDefinition},collectionProvenance={contract:'rubrist/sealed-intake-collection/v1',collectedBySubjectId:custodian,payloadContract:'input-output-steps-only',drawExecutor:'rubrist_server'};
  const predecessors=new Map<string,string>();
  if(input.predecessorRevisionId){const rows=c.db.prepare("SELECT i.id,i.input_digest FROM dataset_revision_items i JOIN dataset_revisions r ON r.id=i.revision_id WHERE r.id=? AND r.project_id=? AND r.role='sealed_validation' ORDER BY i.position").all(input.predecessorRevisionId,actor.projectId);if(!rows.length)throw new GovernedReviewNotFoundError();for(const row of rows)predecessors.set(String(row.input_digest),String(row.id));}
  const prepared=input.items.map((item,position)=>{const payload=projectGovernedReviewPayload(item),inputDigest=datasetInputIdentity({input:item.input}).digest,predecessorItemId=input.predecessorRevisionId?predecessors.get(inputDigest)??null:null;if(input.predecessorRevisionId&&!predecessorItemId)throw new GovernedReviewSealedOverlapError();return {id:stableId('gri',id,'sealed-client-item',item.clientItemId),clientItemId:item.clientItemId,position,payload,inputDigest,predecessorItemId};});
  if(new Set(prepared.map(i=>i.inputDigest)).size!==prepared.length)throw new GovernedReviewSealedOverlapError();
  const frameDigest=digest('governed-sealed-intake-frame/v1',prepared.map(i=>({framePosition:i.position,inputDigest:i.inputDigest,reviewItemId:i.id}))),windowStart=input.timeWindow?governedTimestamp(input.timeWindow.startInclusive):null,windowEnd=input.timeWindow?governedTimestamp(input.timeWindow.endExclusive):null;
  const basis={collectionProvenance,custodianRoleAtReview:'custodian',custodianSubjectId:custodian,frameCount:prepared.length,frameDigest,populationDefinition,predecessorRevisionId:input.predecessorRevisionId??null,windowEnd,windowStart};
  const insert=(table:string,row:Record<string,SQLInputValue>)=>c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  insert('governed_sealed_intake_populations',{id,project_id:actor.projectId,custodian_subject_id:custodian,custodian_role_at_review:'custodian',population_definition:JSON.stringify(populationDefinition),window_start:input.timeWindow?.startInclusive??null,window_end:input.timeWindow?.endExclusive??null,collection_provenance:JSON.stringify(collectionProvenance),frame_count:prepared.length,frame_digest:frameDigest,predecessor_revision_id:input.predecessorRevisionId??null,content_digest:digest('governed-sealed-intake-population/v1',basis),idempotency_key:input.idempotencyKey,request_digest:requestDigest,created_at:c.timestamp,created_command_token:c.token});
  const redaction={contract:'rubrist/governed-review-projection/v1',source:'sealed_session_intake',copiedFields:['input','output','steps'],metadataAccepted:false};
  for(const item of prepared){
   const content={identityBasis:'input-identity/v1',inputDigest:item.inputDigest,redactionProvenance:redaction,reviewPayloadProjectionVersion:'governed-review-payload/v1',reviewPayloadSnapshot:item.payload,sealedFramePosition:item.position,sealedIntakePopulationId:id,sealedPredecessorRevisionId:input.predecessorRevisionId??null,sealedPredecessorRevisionItemId:item.predecessorItemId,sourceKind:'sealed_intake',sourceItemDigest:null,sourceRevisionId:null,sourceRevisionItemId:null};
   insert('governed_review_items',{id:item.id,project_id:actor.projectId,source_kind:'sealed_intake',sealed_intake_population_id:id,sealed_frame_position:item.position,sealed_predecessor_revision_id:input.predecessorRevisionId??null,sealed_predecessor_revision_item_id:item.predecessorItemId,identity_basis:'input-identity/v1',input_digest:item.inputDigest,review_payload_projection_version:'governed-review-payload/v1',review_payload_snapshot:JSON.stringify(item.payload),redaction_provenance:JSON.stringify(redaction),content_digest:digest('governed-review-item/v1',content),idempotency_key:input.idempotencyKey+':item:'+item.position,request_digest:governedReviewRequestDigest({intakeId:id,clientItemId:item.clientItemId,payload:item.payload}),created_by_subject_id:custodian,created_at:c.timestamp});
  }
  insert('governed_sealed_intake_finalizations',{intake_id:id,project_id:actor.projectId,command_token:c.token});
  return receipt(c.db.prepare('SELECT * FROM governed_sealed_intake_populations WHERE id=?').get(id)!);
 },clock);
}
