import type {DatabaseSync} from 'node:sqlite';
import {rowToLifecycle,rowToEvent} from '../../evaluator-lifecycle/storage-values.js';
import {evaluatorLifecycleContentDigest,evaluatorLifecycleEventContentDigest} from '../../lib/evaluator-lifecycle.js';
import {canonicalGovernedJsonV1} from '../../lib/governed-content-digest.js';
import {registerSqliteValidator,type SqliteValidatorReader} from './command-context.js';
import {canonicalGovernedJsonText,governedJsonTextDigest} from './governed-json-text.js';
import {candidateSeed,loadCandidateContext} from './lifecycle-values.js';
const initialized=new WeakSet<DatabaseSync>();
export function lifecycleRequestDigest(read:SqliteValidatorReader,l:Record<string,any>){
 const v=read.get('SELECT * FROM skill_versions WHERE project_id=? AND id=?',l.project_id,l.skill_version_id),s=read.get('SELECT * FROM skills WHERE project_id=? AND id=?',l.project_id,l.skill_id);if(!v||!s)throw new Error('Candidate definition missing');
 const fields:Record<string,unknown>={criterionId:l.criterion_id,criterionVersionId:l.criterion_version_id,expectedBatchDigest:l.governed_batch_digest,expectedTruthContentDigest:l.truth_content_digest,expectedTruthRevisionDigest:l.truth_revision_digest,governedBatchId:l.governed_batch_id,customEndpointUrl:v.custom_endpoint_url,prompt:v.prompt,projectId:l.project_id,rubricMarkdown:v.rubric_markdown,skillDescription:s.description,skillName:s.name,truthDatasetRevisionId:l.truth_dataset_revision_id,decisionThreshold:v.decision_threshold,...(v.rubric_provenance_declared?{rubricProvenance:v.rubric_provenance}:{})};
 const entries=Object.entries(fields).map(([k,v])=>JSON.stringify(k)+':'+JSON.stringify(v));
 for(const [key,column] of [['executionBinding','execution_binding'],['outputSchema','output_schema'],['typedQuestion','typed_question']] as const)entries.push(JSON.stringify(key)+':'+String(v[column]??'null'));
 return governedJsonTextDigest('evaluator-candidate-request/v1','{'+entries.join(',')+'}');
}
export function initializeLifecycleValidator(db:DatabaseSync){
 if(initialized.has(db))return;
 db.function('sqlite_lifecycle_payload_roundtrip',{deterministic:true},payload=>{try{return Number(canonicalGovernedJsonText(String(payload))===canonicalGovernedJsonText(JSON.stringify(JSON.parse(String(payload)))));}catch{return 0;}});
 registerSqliteValidator(db,'analysis_lifecycle_bundle_valid_v1',['evaluator_lifecycle_finalize'],(read,projectId,lifecycleId)=>{
  const l=read.get('SELECT * FROM evaluator_lifecycles WHERE project_id=? AND id=?',projectId,lifecycleId);if(!l)return false;
  const a=rowToLifecycle(l),claim=read.get('SELECT * FROM evaluator_candidate_claims WHERE lifecycle_id=?',lifecycleId);if(!claim)return false;
  for(const [left,right] of [['project_id','project_id'],['truth_revision_id','truth_dataset_revision_id'],['regression_revision_id','regression_dataset_revision_id'],['skill_version_id','skill_version_id'],['skill_id','skill_id'],['criterion_id','criterion_id'],['criterion_version_id','criterion_version_id'],['governed_batch_id','governed_batch_id'],['actor_user_id','created_by_user_id'],['actor_subject_id','created_by_subject_id']] as const)if(claim[left]!==l[right])return false;
  if(!read.get("SELECT 1 FROM project_members m JOIN governed_reviewer_subjects s ON s.project_id=m.project_id AND s.account_user_id=m.user_id WHERE m.project_id=? AND m.user_id=? AND m.role='owner' AND s.id=?",projectId,l.created_by_user_id!,l.created_by_subject_id!))return false;
  const context=loadCandidateContext(read,String(projectId),{criterionId:a.criterionId,criterionVersionId:a.criterionVersionId,governedBatchId:a.governedBatchId,truthDatasetRevisionId:a.truthDatasetRevisionId,expectedBatchDigest:a.governedBatchDigest,expectedTruthRevisionDigest:a.truthRevisionDigest,expectedTruthContentDigest:a.truthContentDigest} as Parameters<typeof loadCandidateContext>[2]);
  if(context.promotion_id!==l.promotion_id||context.truth_item_count!==l.truth_item_count)return false;
  if(a.contentDigest!==evaluatorLifecycleContentDigest(a)||a.requestDigest!==lifecycleRequestDigest(read,l))return false;
  if(!read.get("SELECT 1 FROM criteria c JOIN criterion_versions cv ON cv.criterion_id=c.id AND cv.project_id=c.project_id JOIN skills s ON s.project_id=c.project_id AND s.criterion_id=c.id JOIN skill_versions v ON v.project_id=s.project_id AND v.skill_id=s.id WHERE c.project_id=? AND c.id=? AND c.source_kind='analysis_promotion' AND cv.id=? AND s.id=? AND v.id=? AND v.criterion_version_id=cv.id AND v.regression_dataset_revision_id=? AND v.developer_identity_status='recorded' AND v.created_by_user_id=? AND v.created_by_subject_id=? AND v.created_at=? AND v.status='calibrating' AND v.verdict_kind='binary'",projectId,l.criterion_id!,l.criterion_version_id!,l.skill_id!,l.skill_version_id!,l.regression_dataset_revision_id!,l.created_by_user_id!,l.created_by_subject_id!,l.created_at!))return false;
  if(Number(read.get('SELECT count(*) n FROM skills WHERE project_id=? AND criterion_id=?',projectId,l.criterion_id!)!.n)!==1)return false;
  const r=read.get('SELECT * FROM dataset_revisions WHERE project_id=? AND id=?',projectId,l.regression_dataset_revision_id!);if(!r||r.revision_digest!==l.regression_revision_digest||r.content_digest!==l.regression_content_digest||r.item_count!==l.regression_item_count||r.created_at!==l.created_at||!read.get('SELECT 1 FROM dataset_revision_finalizations WHERE revision_id=?',r.id!))return false;
  if(!read.get('SELECT 1 FROM criterion_regression_revisions WHERE project_id=? AND criterion_version_id=? AND revision_id=?',projectId,l.criterion_version_id!,r.id!))return false;
  const seeds=[...read.iterate('SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_events WHERE lifecycle_id=?',lifecycleId)];if(seeds.length!==1)return false;
  const event=rowToEvent(seeds[0]!),seed=candidateSeed({lifecycleId:a.id,projectId:a.projectId,criterionId:a.criterionId,skillVersionId:a.skillVersionId,userId:a.createdByUserId,subjectId:a.createdBySubjectId},event.id);
  if(event.contentDigest!==evaluatorLifecycleEventContentDigest(seed)||event.occurredAt!==a.createdAt||canonicalGovernedJsonV1(Object.fromEntries(Object.entries(event).filter(([key])=>key!=='contentDigest'&&key!=='occurredAt')))!==canonicalGovernedJsonV1(seed))return false;
  const exposures=[...read.iterate("SELECT * FROM dataset_exposure_events WHERE project_id=? AND evidence_ref_kind='evaluator_lifecycle' AND evidence_ref_id=?",projectId,lifecycleId)];if(exposures.length!==1)return false;
  const e=exposures[0]!;
  if(e.id!==l.developer_exposure_event_id||e.revision_id!==l.truth_dataset_revision_id||e.revision_item_id!==null||e.kind!=='human_access'||e.exposure_class!=='development'||e.activity!=='rubric_authoring'||e.subject_kind!=='person'||e.subject_id!==l.created_by_subject_id||e.actor_user_id!==l.created_by_user_id||e.reason!=='Candidate evaluator authored from governed nonsealed truth'||e.idempotency_key!==`candidate-authoring:${a.id}`||e.occurred_at!==l.created_at||canonicalGovernedJsonText(String(e.details))!==canonicalGovernedJsonV1({criterionId:a.criterionId,skillVersionId:a.skillVersionId}))return false;
  return true;
 });
 initialized.add(db);
}
