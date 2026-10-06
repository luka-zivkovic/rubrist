import type { DatabaseSync,SQLInputValue } from 'node:sqlite';
import { GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError,GovernedReviewSeparationIneligibleError,GovernedReviewSeparationUnknownError } from '../../governed-review/errors.js';
import { COVERED_CAPABILITIES,stableId } from '../../governed-review/storage-values.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { canonicalGovernedJsonV1 } from '../../lib/governed-content-digest.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { sqliteCommand,registerSqliteValidator,type SqliteValidatorReader,type SqliteCommandContext } from './command-context.js';
type Reader=Pick<SqliteValidatorReader,'get'|'iterate'>;
type Result='eligible'|'unknown'|'ineligible';
const initialized=new WeakSet<DatabaseSync>();
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
function reader(db:DatabaseSync):Reader{return {get:(sql,...args)=>db.prepare(sql).get(...args),iterate:(sql,...args)=>db.prepare(sql).iterate(...args)};}
/** Same criterion-lineage facts used by the PostgreSQL separation query. */
export function evaluateGovernedCapability(read:Reader,projectId:string,criterionVersionId:string,subjectId:string){
 const subject=read.get('SELECT account_user_id FROM governed_reviewer_subjects WHERE id=? AND project_id=?',subjectId,projectId);if(!subject)throw new GovernedReviewNotFoundError();
 const accountId=subject.account_user_id===null?null:String(subject.account_user_id),excluded=new Set<string>(),unknown=new Set<string>();
 let criterionCount=0,instructionCount=0,evaluatorCount=0,criterionKnown=true,instructionKnown=true;
 for(const row of read.iterate('SELECT candidate.created_by_user_id FROM criterion_versions target JOIN criterion_versions candidate ON candidate.project_id=target.project_id AND candidate.criterion_id=target.criterion_id WHERE target.id=? AND target.project_id=?',criterionVersionId,projectId)){
  criterionCount++;if(!row.created_by_user_id){criterionKnown=false;unknown.add('criterion_author_identity');}if(accountId&&row.created_by_user_id===accountId)excluded.add('criterion_authoring');
 }
 for(const row of read.iterate('SELECT i.created_by_subject_id FROM criterion_versions target JOIN criterion_versions candidate ON candidate.project_id=target.project_id AND candidate.criterion_id=target.criterion_id JOIN review_instruction_versions i ON i.project_id=candidate.project_id AND i.criterion_version_id=candidate.id WHERE target.id=? AND target.project_id=?',criterionVersionId,projectId)){
  instructionCount++;if(!row.created_by_subject_id){instructionKnown=false;unknown.add('instruction_author_identity');}if(row.created_by_subject_id===subjectId)excluded.add('instruction_authoring');
 }
 for(const row of read.iterate('SELECT v.developer_identity_status,v.created_by_subject_id,EXISTS(SELECT 1 FROM governed_evaluator_development_events e WHERE e.skill_version_id=v.id AND e.project_id=v.project_id AND e.criterion_version_id=v.criterion_version_id) has_event FROM skill_versions v JOIN criterion_versions vc ON vc.id=v.criterion_version_id JOIN criterion_versions target ON target.project_id=vc.project_id AND target.criterion_id=vc.criterion_id WHERE v.project_id=? AND target.id=?',projectId,criterionVersionId)){
  evaluatorCount++;if(row.developer_identity_status!=='recorded'||!row.has_event)unknown.add('evaluator_author_identity');if(row.created_by_subject_id===subjectId)excluded.add('evaluator_authoring');
 }
 if(read.get('SELECT 1 FROM governed_evaluator_development_events e JOIN criterion_versions ec ON ec.id=e.criterion_version_id JOIN criterion_versions target ON target.project_id=ec.project_id AND target.criterion_id=ec.criterion_id WHERE e.project_id=? AND target.id=? AND e.developer_subject_id=? LIMIT 1',projectId,criterionVersionId,subjectId))excluded.add('evaluator_authoring');
 const exposure=Boolean(read.get("SELECT 1 FROM dataset_exposure_events WHERE project_id=? AND exposure_class='development' AND (subject_id=? OR (? IS NOT NULL AND subject_id=?)) LIMIT 1",projectId,subjectId,accountId,accountId));if(exposure)excluded.add('development_exposure');
 const sortedExcluded=[...excluded].sort(),sortedUnknown=[...unknown].sort();
 return {result:(sortedExcluded.length?'ineligible':sortedUnknown.length?'unknown':'eligible') as Result,excluded:sortedExcluded,unknown:sortedUnknown,findings:{criterionAuthorKnown:criterionCount>0&&criterionKnown,instructionAuthorKnown:instructionCount>0&&instructionKnown,evaluatorVersionsChecked:evaluatorCount,recordedDevelopmentExposure:exposure}};
}
function evidence(criterionVersionId:string,evaluated:ReturnType<typeof evaluateGovernedCapability>){return {contract:'rubrist/sealed-separation-evidence/v1',criterionVersionId,evaluatedCapabilities:[...COVERED_CAPABILITIES],findings:evaluated.findings};}
export function initializeGovernedCapabilityValidator(db:DatabaseSync):void {
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_governed_capability_valid_v1',['governed_capability_insert'],(read,projectId,criterionVersionId,subjectId,result,excluded,unknown,storedEvidence)=>{
  const evaluated=evaluateGovernedCapability(read,String(projectId),String(criterionVersionId),String(subjectId));
  return evaluated.result===result&&canonicalGovernedJsonV1(evaluated.excluded)===String(excluded)&&canonicalGovernedJsonV1(evaluated.unknown)===String(unknown)&&canonicalGovernedJsonV1(evidence(String(criterionVersionId),evaluated))===String(storedEvidence);
 });
 registerSqliteValidator(db,'analysis_governed_separation_valid_v1',['governed_sealed_open','governed_sealed_task_access','governed_sealed_alignment_access','governed_sealed_adjudication_access'],(read,batchId,scope,subjectId)=>{
  const batch=read.get('SELECT project_id,criterion_version_id FROM governed_review_batches WHERE id=?',batchId);if(!batch)return false;
  const check=read.get('SELECT result FROM governed_review_capability_checks WHERE batch_id=? AND check_scope=? AND subject_id=? AND evaluator_version_id IS NULL ORDER BY sequence DESC LIMIT 1',batchId,scope,subjectId);
  return check?.result==='eligible'&&evaluateGovernedCapability(read,String(batch.project_id),String(batch.criterion_version_id),String(subjectId)).result==='eligible';
 });initialized.add(db);
}
/** Called inside an owning command after validator initialization at entry. */
export function appendGovernedCapabilityChecks(db:DatabaseSync,c:SqliteCommandContext,batchId:string,scope:'batch_open'|'adjudication'|'truth_freeze',subjectIds:string[],commandKey:string):Result {
 const batch=c.db.prepare('SELECT project_id,criterion_version_id FROM governed_review_batches WHERE id=?').get(batchId);if(!batch)throw new GovernedReviewNotFoundError();
 const projectId=String(batch.project_id),criterionVersionId=String(batch.criterion_version_id);let aggregate:Result='eligible';
 for(const subjectId of [...new Set(subjectIds)].sort()){
  const evaluated=evaluateGovernedCapability(reader(db),projectId,criterionVersionId,subjectId);
  if(evaluated.result==='ineligible')aggregate='ineligible';else if(evaluated.result==='unknown'&&aggregate==='eligible')aggregate='unknown';
  const base=`capability:${batchId}:${scope}:${subjectId}:${commandKey}`,requestDigest=governedReviewRequestDigest({batchId,scope,subjectId,evidence:evaluated});let key=base;
  let prior=c.db.prepare('SELECT request_digest FROM governed_review_capability_checks WHERE project_id=? AND idempotency_key=?').get(projectId,key);
  if(prior){if(prior.request_digest===requestDigest)continue;key=base+':'+requestDigest.slice(7,23);prior=c.db.prepare('SELECT request_digest FROM governed_review_capability_checks WHERE project_id=? AND idempotency_key=?').get(projectId,key);if(prior){if(prior.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();continue;}}
  const version=Number(c.db.prepare('SELECT coalesce(max(sequence),0) v FROM governed_review_capability_checks WHERE batch_id=? AND check_scope=? AND subject_id=? AND evaluator_version_id IS NULL').get(batchId,scope,subjectId)!.v),sequence=version+1;
  const payload=evidence(criterionVersionId,evaluated),evidenceDigest=digest('sealed-separation-evidence/v1',payload);
  const basis={batchId,capabilityQueryVersion:'sealed-separation/v1',checkScope:scope,coveredCapabilities:[...COVERED_CAPABILITIES],evidenceDigest,evaluatorVersionId:null,excludedCapabilities:evaluated.excluded,result:evaluated.result,sequence,subjectId,unknownCapabilities:evaluated.unknown,verificationMethod:'system_derived'};
  const row:Record<string,SQLInputValue>={id:stableId('grcc',batchId,scope,subjectId,key),project_id:projectId,batch_id:batchId,criterion_version_id:criterionVersionId,evaluator_version_id:null,subject_id:subjectId,sequence,expected_previous_sequence:version,check_scope:scope,result:evaluated.result,verification_method:'system_derived',capability_query_version:'sealed-separation/v1',covered_capabilities:JSON.stringify(COVERED_CAPABILITIES),excluded_capabilities:JSON.stringify(evaluated.excluded),unknown_capabilities:JSON.stringify(evaluated.unknown),evidence:JSON.stringify(payload),evidence_digest:evidenceDigest,content_digest:digest('governed-review-capability-check/v1',basis),idempotency_key:key,request_digest:requestDigest,checked_at:c.timestamp};
  c.db.prepare(`INSERT INTO governed_review_capability_checks(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 return aggregate;
}

/** Commit failed capability evidence while returning no protected payload. */
export function governedEvidenceCommand<T>(db:DatabaseSync,work:(c:SqliteCommandContext)=>T|GovernedReviewSeparationIneligibleError|GovernedReviewSeparationUnknownError,clock=Date.now):T {
 initializeGovernedCapabilityValidator(db);
 const result=sqliteCommand(db,work,clock);
 if(result instanceof GovernedReviewSeparationIneligibleError||result instanceof GovernedReviewSeparationUnknownError)throw result;
 return result;
}
export function checkGovernedSeparation(db:DatabaseSync,c:SqliteCommandContext,batchId:string,scope:'batch_open'|'adjudication'|'truth_freeze',subjects:string[],key:string){
 if(c.db.prepare('SELECT role_intent FROM governed_review_batches WHERE id=?').get(batchId)?.role_intent!=='sealed_validation')return null;
 const result=appendGovernedCapabilityChecks(db,c,batchId,scope,subjects,key);
 return result==='unknown'?new GovernedReviewSeparationUnknownError():result==='ineligible'?new GovernedReviewSeparationIneligibleError():null;
}
export function governedContentSubjects(c:SqliteCommandContext,batchId:string,includePostBarrier=false):string[]{
 const subjects=c.db.prepare('SELECT custodian_subject_id subject_id FROM governed_review_batches WHERE id=? AND custodian_subject_id IS NOT NULL UNION SELECT reviewer_subject_id FROM governed_review_tasks WHERE batch_id=?').all(batchId,batchId).map(r=>String(r.subject_id));
 if(includePostBarrier)subjects.push(...c.db.prepare("SELECT adjudicator_subject_id subject_id FROM governed_review_adjudications WHERE batch_id=? UNION SELECT subject_id FROM governed_review_capability_checks WHERE batch_id=? AND check_scope='adjudication' AND result='eligible'").all(batchId,batchId).map(r=>String(r.subject_id)));
 return [...new Set(subjects)].sort();
}
