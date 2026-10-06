import type {DatabaseSync} from 'node:sqlite';
import type {EvaluatorLifecycleEvent} from '@rubrist/shared';
import {lifecycleRawEvent as rawEvent,lifecycleRawEventDigest} from './lifecycle-values.js';
import {evaluatorLifecycleDigest,evaluatorLifecycleTransitionAllowed} from '../../lib/evaluator-lifecycle.js';
import {registerSqliteValidator,type SqliteValidatorReader} from './command-context.js';
type Row=Record<string,any>;
const eventQuery='SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_events';
function requestDigest(read:SqliteValidatorReader,e:EvaluatorLifecycleEvent,prior:Row){
 const expected={expectedEventDigest:prior.content_digest,expectedEventId:prior.id,expectedSequence:String(prior.sequence),expectedState:prior.state,projectId:e.projectId,rationale:e.reason,skillVersionId:e.skillVersionId};
 if(e.transition==='retired'&&e.activationBundleId===null)return evaluatorLifecycleDigest({basis:'evaluator-lifecycle-retired-request/v1',...expected});
 if(e.transition==='activated'){
  const replaced=e.replacedSkillVersionId?read.get(`SELECT p.id,p.content_digest,CAST(p.sequence AS TEXT) sequence FROM evaluator_lifecycle_events r JOIN evaluator_lifecycle_events p ON p.id=r.predecessor_event_id WHERE r.project_id=? AND r.activation_bundle_id=? AND r.transition='retired' AND r.skill_version_id=?`,e.projectId,e.activationBundleId,e.replacedSkillVersionId):null;
  return evaluatorLifecycleDigest({basis:'evaluator-lifecycle-activated-request/v1',...expected,calibrationArtifactId:e.activationEvidence!.calibrationArtifactId,expectedCalibrationArtifactDigest:e.activationEvidence!.calibrationArtifactDigest,expectedCalibrationEvidenceDigest:e.activationEvidence!.calibrationEvidenceDigest,expectedPriorActiveEventDigest:replaced?.content_digest??null,expectedPriorActiveEventId:replaced?.id??null,expectedPriorActiveSkillVersionId:e.replacedSkillVersionId,regressionRunId:e.activationEvidence!.regressionRunId});
 }
 if(e.transition==='calibration_revoked'){
  if(!e.idempotencyKey.startsWith('calibration-revocation:'))return null;
  const revocationId=e.idempotencyKey.slice('calibration-revocation:'.length),revocation=read.get('SELECT * FROM binary_calibration_revocation_events WHERE project_id=? AND id=?',e.projectId,revocationId);
  if(!revocation||revocation.artifact_id!==prior.calibration_artifact_id||e.reason!==`Calibration artifact revoked: ${revocation.reason}`)return null;
  const id='elce_'+evaluatorLifecycleDigest({basis:'evaluator-lifecycle-revocation-id/v1',revocationId}).replace(':','').slice(7,55);if(e.id!==id)return null;
  return evaluatorLifecycleDigest({basis:'evaluator-lifecycle-revocation-request/v1',artifactId:revocation.artifact_id,lifecycleId:e.lifecycleId,revocationId});
 }
 return e.requestDigest;
}
const initialized=new WeakSet<DatabaseSync>();
export function initializeLifecycleTransitionValidator(db:DatabaseSync){
 if(initialized.has(db))return;
 // Pure serialization for SQL-triggered system revocations, no database access.
 db.function('sqlite_lifecycle_event_digest',{deterministic:true},json=>{try{return lifecycleRawEventDigest(JSON.parse(String(json)));}catch{return '';}});
 registerSqliteValidator(db,'analysis_lifecycle_transition_valid_v1',['evaluator_lifecycle_transition_insert'],(read,json)=>{
  const row=JSON.parse(String(json)) as Row,e=rawEvent(row),l=read.get('SELECT * FROM evaluator_lifecycles WHERE project_id=? AND id=?',e.projectId,e.lifecycleId);
  if(!l||l.criterion_id!==e.criterionId||l.skill_version_id!==e.skillVersionId)return false;
  const prior=read.get('SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_heads WHERE lifecycle_id=?',e.lifecycleId);
  if(!prior||prior.id!==e.predecessorEventId||prior.content_digest!==e.predecessorEventDigest||BigInt(String(prior.sequence))+1n!==BigInt(e.sequence)||!evaluatorLifecycleTransitionAllowed(prior.state as any,e.state))return false;
  if(e.actorRole==='owner'&&!read.get("SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id AND m.role='owner' WHERE s.project_id=? AND s.id=? AND s.account_user_id=?",e.projectId,e.actorSubjectId,e.actorUserId))return false;
  if(e.transition==='retired'&&e.activationBundleId!==null&&prior.state!=='active')return false;
  if(e.requestDigest!==requestDigest(read,e,prior)||e.contentDigest!==lifecycleRawEventDigest(row))return false;
  if(e.transition==='activated'){
   const a=e.activationEvidence!;
   if(!read.get(`SELECT 1 FROM binary_calibration_artifacts a JOIN binary_calibration_runs r ON r.id=a.run_id AND r.project_id=a.project_id JOIN binary_calibration_exposure_checks x ON x.id=r.completion_check_id AND x.phase='completion' WHERE a.project_id=? AND a.id=? AND a.artifact_digest=? AND a.evidence_digest=? AND a.status='complete' AND r.skill_version_id=? AND r.criterion_version_id=? AND NOT EXISTS(SELECT 1 FROM binary_calibration_revocation_events WHERE artifact_id=a.id) AND NOT EXISTS(SELECT 1 FROM dataset_exposure_events e WHERE e.revision_id=r.dataset_revision_id AND e.occurred_at>=x.recorded_at AND (e.exposure_class='development' OR e.activity IN('declassify','analysis_authoring','rubric_authoring','prompt_tuning','example_selection','model_selection','development_run','regression_run')))`,e.projectId,a.calibrationArtifactId,a.calibrationArtifactDigest,a.calibrationEvidenceDigest,e.skillVersionId,l.criterion_version_id!))return false;
   if(a.regressionDatasetRevisionId!==l.regression_dataset_revision_id||!read.get(`SELECT 1 FROM regression_runs r JOIN dataset_revisions d ON d.id=r.dataset_revision_id AND d.project_id=r.project_id WHERE r.project_id=? AND r.id=? AND r.skill_version_id=? AND r.dataset_revision_id=? AND r.status='passed' AND r.golden_set_missing=0 AND d.item_count>0 AND r.compared=d.item_count AND r.regressed=0 AND r.override_reason IS NULL AND r.error_message IS NULL AND json_type(r.cases)='array' AND json_array_length(r.cases)=d.item_count AND NOT EXISTS(SELECT 1 FROM dataset_revision_items i WHERE i.revision_id=d.id AND NOT EXISTS(SELECT 1 FROM json_each(r.cases) o WHERE json_extract(o.value,'$.caseId')=i.id AND json_extract(o.value,'$.agreedLabel')=i.reference_label AND json_extract(o.value,'$.newLabel') IN('pass','fail','ambiguous') AND json_extract(o.value,'$.change') IN('agree','improve'))) AND NOT EXISTS(SELECT 1 FROM json_each(r.cases) o GROUP BY json_extract(o.value,'$.caseId') HAVING count(*)<>1)`,e.projectId,a.regressionRunId,e.skillVersionId,a.regressionDatasetRevisionId))return false;
   if(read.get("SELECT 1 FROM evaluator_lifecycle_heads WHERE project_id=? AND criterion_id=? AND state='active'",e.projectId,e.criterionId))return false;
  }
  return true;
 });
 registerSqliteValidator(db,'analysis_lifecycle_activation_bundle_valid_v1',['evaluator_lifecycle_activation_finalize'],(read,projectId,bundleId)=>{
  const rows=[...read.iterate(eventQuery+' WHERE project_id=? AND activation_bundle_id=?',projectId,bundleId)],activated=rows.filter(r=>r.transition==='activated');if(activated.length!==1)return false;
  const a=rawEvent(activated[0]!),retired=rows.filter(r=>r.transition==='retired');
  if(a.replacedSkillVersionId===null)return rows.length===1&&read.get('SELECT id FROM evaluator_lifecycle_heads WHERE lifecycle_id=?',a.lifecycleId)?.id===a.id;
  if(rows.length!==2||retired.length!==1)return false;
  const r=rawEvent(retired[0]!);
  if(r.projectId!==a.projectId||r.criterionId!==a.criterionId||r.skillVersionId!==a.replacedSkillVersionId||r.requestDigest!==a.requestDigest||r.reason!==`Replaced by activated evaluator ${a.skillVersionId}.`||r.actorUserId!==a.actorUserId||r.actorSubjectId!==a.actorSubjectId||r.actorRole!==a.actorRole||r.idempotencyKey!==`activation-replacement:${a.activationBundleId}`||r.occurredAt!==a.occurredAt)return false;
  return read.get('SELECT id FROM evaluator_lifecycle_heads WHERE lifecycle_id=?',a.lifecycleId)?.id===a.id&&read.get('SELECT id FROM evaluator_lifecycle_heads WHERE lifecycle_id=?',r.lifecycleId)?.id===r.id;
 });
 initialized.add(db);
}
