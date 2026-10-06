import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {EVALUATOR_LIFECYCLE_CONTRACT_VERSION,defaultEvaluatorOutputSchema,type EvaluatorCandidateCreateInput,type DatasetRevisionPayloadSnapshot,type EvaluatorLifecycleArtifact,type DatasetReferenceProvenance} from '@rubrist/shared';
import type {EvaluatorLifecycleAccess,ResolvedBinding} from '../../evaluator-lifecycle/repository.js';
import {requireOwner,repoError,rejectMutableModelAlias,rejectUngovernedBinding} from '../../evaluator-lifecycle/storage-values.js';
import {ExecutionBindingInputError,executionBindingFromInput} from '../../lib/execution-binding.js';
import {sha256Digest} from '../../lib/canonical-json.js';
import {evaluatorCandidateRequestDigest,evaluatorLifecycleContentDigest} from '../../lib/evaluator-lifecycle.js';
import {datasetRevisionContentDigest,datasetRevisionDigest,datasetRevisionItemDigest} from '../../lib/dataset-revision.js';
import {sqliteCommand} from './command-context.js';
import {sqliteResolutionStore} from './resolution-commands.js';
import {loadLifecycleCandidateResult} from './lifecycle-reads.js';
import {insertLifecycleRow as insert,ensureLifecycleOwner,loadCandidateContext,truthItems,regressionCopyBasis,candidateSeed,insertLifecycleEvent} from './lifecycle-values.js';
import {initializeLifecycleValidator} from './lifecycle-validator.js';
export function createLifecycleCandidate(db:DatabaseSync,actor:EvaluatorLifecycleAccess,input:EvaluatorCandidateCreateInput,resolution:ResolvedBinding|null=null){
 requireOwner(actor);initializeLifecycleValidator(db);
 let stored:ReturnType<typeof executionBindingFromInput>;
 try{stored=executionBindingFromInput(input.executionBinding,undefined,{typedQuestion:input.typedQuestion!==undefined});}catch(error){if(error instanceof ExecutionBindingInputError)throw repoError('invalid_execution_binding',error.message);throw error;}
 const requestDigest=evaluatorCandidateRequestDigest(actor.projectId,input);
 return sqliteCommand(db,c=>{
  const prior=c.db.prepare('SELECT * FROM evaluator_lifecycles WHERE project_id=? AND idempotency_key=?').get(actor.projectId,input.idempotencyKey);
  if(prior){if(prior.request_digest!==requestDigest)throw repoError('idempotency_conflict','Candidate idempotency key was already used for different semantics');return loadLifecycleCandidateResult(db,actor.projectId,String(prior.skill_version_id),true);}
  rejectMutableModelAlias(stored.executionBinding.modelId,'become a candidate');
  const record=resolution?.bindingDigest===sha256Digest(stored.executionBinding)?resolution.record:null;
  rejectUngovernedBinding(stored.executionBinding,record);
  const subjectId=ensureLifecycleOwner(c,actor),read={get:(sql:string,...values:import('node:sqlite').SQLInputValue[])=>db.prepare(sql).get(...values),iterate:(sql:string,...values:import('node:sqlite').SQLInputValue[])=>db.prepare(sql).iterate(...values)},context=loadCandidateContext(read,actor.projectId,input);
  const sourceItems=[...truthItems(read,actor.projectId,input.truthDatasetRevisionId)];
  if(sourceItems.length!==Number(context.truth_item_count)||sourceItems.length===0)throw repoError('truth_conflict','Frozen candidate truth must contain at least one completely resolved pass/fail item');
  const lifecycleId=`elc_${randomUUID()}`,skillVersionId=`skillv_${randomUUID()}`,regressionId=`dsr_${randomUUID()}`;
  const existing=c.db.prepare('SELECT * FROM skills WHERE project_id=? AND criterion_id=?').get(actor.projectId,input.criterionId),skillId=existing?String(existing.id):`skill_${randomUUID()}`;
  if(existing&&(existing.name!==input.skillName||existing.description!==input.skillDescription))throw repoError('candidate_provenance_conflict','Existing governed evaluator lineage has different immutable skill identity text');
  insert(c,'evaluator_candidate_claims',{lifecycle_id:lifecycleId,project_id:actor.projectId,truth_revision_id:input.truthDatasetRevisionId,regression_revision_id:regressionId,skill_version_id:skillVersionId,skill_id:skillId,criterion_id:input.criterionId,criterion_version_id:input.criterionVersionId,governed_batch_id:input.governedBatchId,actor_user_id:actor.userId,actor_subject_id:subjectId,command_token:c.token});
  if(!existing)insert(c,'skills',{id:skillId,project_id:actor.projectId,name:input.skillName,description:input.skillDescription,owner_user_id:actor.userId,status:'calibrating',is_starter:0,criterion_id:input.criterionId,created_at:c.timestamp});
  const prepared=sourceItems.map((row,position)=>{
   const payload=JSON.parse(String(row.payload_snapshot)) as DatasetRevisionPayloadSnapshot,referenceLabel=row.reference_label==='fail'?'fail':'pass';
   const provenance:DatasetReferenceProvenance={kind:'dataset_claim',sourceId:String(row.truth_link_id),verdictIds:[],actorUserIds:[],basis:regressionCopyBasis};
   const itemDigest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(row.input_digest)},redactedPayload:payload,referenceLabel,expectedFailStep:null,reviewProvenance:provenance,note:null});
   // Preserve the original TEXT; the database separately verifies PG numeric parity.
   return {id:`dsri_${randomUUID()}`,revision_id:regressionId,project_id:actor.projectId,position,input_digest:String(row.input_digest),item_digest:itemDigest,payload_snapshot:String(row.payload_snapshot),reference_label:referenceLabel,reference_provenance:JSON.stringify(provenance),created_at:c.timestamp};
  });
  const digests=prepared.map(i=>i.item_digest),contentDigest=datasetRevisionContentDigest(digests),revisionDigest=datasetRevisionDigest({role:'regression_golden',itemDigests:digests}),seriesId=`candidate-regression:${actor.projectId}:${input.criterionVersionId}`;
  const predecessor=c.db.prepare('SELECT id,revision_number FROM dataset_revisions WHERE project_id=? AND series_id=? ORDER BY revision_number DESC,id DESC LIMIT 1').get(actor.projectId,seriesId);
  insert(c,'dataset_revisions',{id:regressionId,project_id:actor.projectId,series_id:seriesId,revision_number:Number(predecessor?.revision_number??0)+1,parent_revision_id:predecessor?.id??null,role:'regression_golden',source_kind:'golden_snapshot',identity_basis:'input-identity/v1',content_digest:contentDigest,revision_digest:revisionDigest,item_count:prepared.length,provenance_level:'governed_blind',created_by_user_id:actor.userId,idempotency_key:`candidate-regression:${lifecycleId}`,criterion_version_id:input.criterionVersionId,created_at:c.timestamp});
  for(const row of prepared)insert(c,'dataset_revision_items',row);
  insert(c,'dataset_revision_finalizations',{revision_id:regressionId,project_id:actor.projectId});
  c.db.prepare('INSERT INTO criterion_regression_revisions VALUES(?,?,?,?) ON CONFLICT(project_id,criterion_version_id) DO UPDATE SET revision_id=excluded.revision_id,updated_at=excluded.updated_at').run(actor.projectId,input.criterionVersionId,regressionId,c.timestamp);
  const number=Number(c.db.prepare('SELECT count(*) n FROM skill_versions WHERE project_id=? AND skill_id=?').get(actor.projectId,skillId)!.n)+1;
  insert(c,'skill_versions',{id:skillVersionId,skill_id:skillId,project_id:actor.projectId,criterion_id:input.criterionId,criterion_version_id:input.criterionVersionId,version:`${number}.0.0`,status:'calibrating',rubric_markdown:input.rubricMarkdown??null,prompt:input.prompt??null,typed_question:input.typedQuestion===undefined?null:JSON.stringify(input.typedQuestion),decision_threshold:input.decisionThreshold??null,output_schema:JSON.stringify(input.outputSchema??defaultEvaluatorOutputSchema(stored.executionBinding.verdictProtocol)),execution_binding:JSON.stringify(stored.executionBinding),custom_endpoint_url:stored.customEndpointUrl,golden_set_agreement:null,too_strict_count:0,too_lenient_count:0,ambiguous_count:0,known_limitations:'[]',verdict_kind:'binary',scalar_range:null,categorical_choice_scores:null,rubric_provenance:input.rubricProvenance??'unspecified',rubric_provenance_declared:Number((input.rubricProvenance??'unspecified')!=='unspecified'),regression_dataset_revision_id:regressionId,created_at:c.timestamp,approved_at:null,created_by_user_id:actor.userId,created_by_subject_id:subjectId,developer_identity_status:'recorded'});
  sqliteResolutionStore(db).save(actor.projectId,skillVersionId,stored.executionBinding,record!);
  const exposureId=`dse_${randomUUID()}`;
  insert(c,'dataset_exposure_events',{id:exposureId,project_id:actor.projectId,revision_id:input.truthDatasetRevisionId,kind:'human_access',exposure_class:'development',activity:'rubric_authoring',subject_kind:'person',subject_id:subjectId,actor_user_id:actor.userId,evidence_ref_kind:'evaluator_lifecycle',evidence_ref_id:lifecycleId,reason:'Candidate evaluator authored from governed nonsealed truth',details:JSON.stringify({criterionId:input.criterionId,skillVersionId}),idempotency_key:`candidate-authoring:${lifecycleId}`,occurred_at:c.timestamp});
  const artifact:Omit<EvaluatorLifecycleArtifact,'contentDigest'|'createdAt'>={id:lifecycleId,contractVersion:EVALUATOR_LIFECYCLE_CONTRACT_VERSION,projectId:actor.projectId,criterionId:input.criterionId,criterionVersionId:input.criterionVersionId,skillId,skillVersionId,promotionId:String(context.promotion_id),governedBatchId:input.governedBatchId,governedBatchDigest:input.expectedBatchDigest,truthDatasetRevisionId:input.truthDatasetRevisionId,truthRevisionDigest:input.expectedTruthRevisionDigest,truthContentDigest:input.expectedTruthContentDigest,truthItemCount:sourceItems.length,regressionDatasetRevisionId:regressionId,regressionRevisionDigest:revisionDigest,regressionContentDigest:contentDigest,regressionItemCount:prepared.length,developerExposureEventId:exposureId,createdByUserId:actor.userId,createdBySubjectId:subjectId,idempotencyKey:input.idempotencyKey,requestDigest};
  const row=Object.fromEntries(Object.entries({...artifact,contentDigest:evaluatorLifecycleContentDigest(artifact),createdAt:c.timestamp}).map(([key,value])=>[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),value]));
  insert(c,'evaluator_lifecycles',row);
  insertLifecycleEvent(c,candidateSeed({lifecycleId,projectId:actor.projectId,criterionId:input.criterionId,skillVersionId,userId:actor.userId,subjectId}));
  insert(c,'evaluator_lifecycle_finalizations',{lifecycle_id:lifecycleId,project_id:actor.projectId,command_token:c.token});
  return loadLifecycleCandidateResult(db,actor.projectId,skillVersionId,false);
 });
}
