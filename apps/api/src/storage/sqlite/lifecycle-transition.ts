import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ExecutionBindingSchema,EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,type EvaluatorLifecycleActivateInput,type EvaluatorLifecycleRetireInput,type EvaluatorLifecycleEvent} from '@rubrist/shared';
import type {EvaluatorLifecycleAccess} from '../../evaluator-lifecycle/repository.js';
import {requireOwner,repoError,rejectMutableModelAlias,rejectUngovernedBinding} from '../../evaluator-lifecycle/storage-values.js';
import {evaluatorLifecycleDigest} from '../../lib/evaluator-lifecycle.js';
import {sqliteCommand} from './command-context.js';
import {lifecycleHead,loadLifecycleTransitionResult} from './lifecycle-reads.js';
import {ensureLifecycleOwner,insertLifecycleEvent,insertLifecycleRow} from './lifecycle-values.js';
import {sqliteResolutionStore} from './resolution-commands.js';
import {initializeLifecycleTransitionValidator} from './lifecycle-transition-validator.js';
export function transitionLifecycle(db:DatabaseSync,actor:EvaluatorLifecycleAccess,skillVersionId:string,input:EvaluatorLifecycleActivateInput|EvaluatorLifecycleRetireInput,transition:'activated'|'retired'){
 requireOwner(actor);initializeLifecycleTransitionValidator(db);
 const {idempotencyKey:_key,...semantic}=input,requestDigest=evaluatorLifecycleDigest({basis:`evaluator-lifecycle-${transition}-request/v1`,projectId:actor.projectId,skillVersionId,...semantic});
 return sqliteCommand(db,c=>{
  const prior=c.db.prepare('SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_events WHERE project_id=? AND idempotency_key=?').get(actor.projectId,input.idempotencyKey);
  if(prior){if(prior.request_digest!==requestDigest)throw repoError('idempotency_conflict','Lifecycle transition idempotency key was reused');return loadLifecycleTransitionResult(db,actor.projectId,prior,true);}
  const lifecycle=c.db.prepare('SELECT * FROM evaluator_lifecycles WHERE project_id=? AND skill_version_id=?').get(actor.projectId,skillVersionId);if(!lifecycle)throw repoError('not_found','Evaluator lifecycle not found');
  const subjectId=ensureLifecycleOwner(c,actor),head=lifecycleHead(db,String(lifecycle.id));
  if(!head||head.state!==input.expectedState||head.sequence!==input.expectedSequence||head.id!==input.expectedEventId||head.content_digest!==input.expectedEventDigest)throw repoError('state_conflict','Evaluator lifecycle head changed before the transition');
  const bundleId=transition==='activated'?`elab_${randomUUID()}`:null;
  if(transition==='activated'){
   const activation=input as EvaluatorLifecycleActivateInput,row=c.db.prepare('SELECT execution_binding FROM skill_versions WHERE project_id=? AND id=?').get(actor.projectId,skillVersionId);if(!row)throw repoError('not_found','Evaluator version not found');
   const binding=ExecutionBindingSchema.parse(JSON.parse(String(row.execution_binding)));rejectMutableModelAlias(binding.modelId,'be activated');rejectUngovernedBinding(binding,sqliteResolutionStore(db).load(actor.projectId,skillVersionId,binding));
   const active=c.db.prepare("SELECT l.*,h.id head_id,CAST(h.sequence AS TEXT) head_sequence,h.content_digest head_digest FROM evaluator_lifecycles l JOIN evaluator_lifecycle_heads h ON h.lifecycle_id=l.id WHERE l.project_id=? AND l.criterion_id=? AND h.state='active' AND l.skill_version_id<>?").get(actor.projectId,lifecycle.criterion_id!,skillVersionId);
   if(active){
    if(activation.expectedPriorActiveSkillVersionId!==active.skill_version_id||activation.expectedPriorActiveEventId!==active.head_id||activation.expectedPriorActiveEventDigest!==active.head_digest)throw repoError('prior_active_conflict','Activation must name the exact current prior active evaluator');
    insertLifecycleEvent(c,{id:`elce_${randomUUID()}`,contractVersion:EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,lifecycleId:String(active.id),projectId:actor.projectId,criterionId:String(active.criterion_id),skillVersionId:String(active.skill_version_id),sequence:String(BigInt(String(active.head_sequence))+1n),transition:'retired',state:'retired',predecessorEventId:String(active.head_id),predecessorEventDigest:String(active.head_digest),activationBundleId:bundleId,activationEvidence:null,replacedSkillVersionId:null,actorUserId:actor.userId,actorSubjectId:subjectId,actorRole:'owner',reason:`Replaced by activated evaluator ${skillVersionId}.`,idempotencyKey:`activation-replacement:${bundleId}`,requestDigest});
   }else if(activation.expectedPriorActiveSkillVersionId!==null||activation.expectedPriorActiveEventId!==null||activation.expectedPriorActiveEventDigest!==null)throw repoError('prior_active_conflict','Activation expected a prior active evaluator but none exists');
  }
  const activation=transition==='activated'?input as EvaluatorLifecycleActivateInput:null;
  const event:Omit<EvaluatorLifecycleEvent,'contentDigest'|'occurredAt'>={id:`elce_${randomUUID()}`,contractVersion:EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,lifecycleId:String(lifecycle.id),projectId:actor.projectId,criterionId:String(lifecycle.criterion_id),skillVersionId,sequence:String(BigInt(String(head.sequence))+1n),transition,state:transition==='activated'?'active':'retired',predecessorEventId:String(head.id),predecessorEventDigest:String(head.content_digest),activationBundleId:bundleId,activationEvidence:activation?{calibrationArtifactId:activation.calibrationArtifactId,calibrationArtifactDigest:activation.expectedCalibrationArtifactDigest,calibrationEvidenceDigest:activation.expectedCalibrationEvidenceDigest,regressionRunId:activation.regressionRunId,regressionDatasetRevisionId:String(lifecycle.regression_dataset_revision_id)}:null,replacedSkillVersionId:activation?.expectedPriorActiveSkillVersionId??null,actorUserId:actor.userId,actorSubjectId:subjectId,actorRole:'owner',reason:input.rationale,idempotencyKey:input.idempotencyKey,requestDigest};
  insertLifecycleEvent(c,event);
  if(bundleId)insertLifecycleRow(c,'evaluator_activation_finalizations',{bundle_id:bundleId,project_id:actor.projectId,command_token:c.token});
  const stored=c.db.prepare('SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_events WHERE id=?').get(event.id)!;
  return loadLifecycleTransitionResult(db,actor.projectId,stored,false);
 });
}
