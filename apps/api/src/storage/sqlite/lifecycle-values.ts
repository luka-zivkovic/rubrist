import {createHash,randomUUID} from 'node:crypto';
import type {SQLInputValue} from 'node:sqlite';
import {EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,type EvaluatorLifecycleEvent,type EvaluatorCandidateCreateInput} from '@rubrist/shared';
import {repoError,rowToEvent} from '../../evaluator-lifecycle/storage-values.js';
import type {EvaluatorLifecycleAccess} from '../../evaluator-lifecycle/repository.js';
import {evaluatorLifecycleDigest,evaluatorLifecycleEventContentDigest} from '../../lib/evaluator-lifecycle.js';
import {governedContentV1Digest} from '../../lib/governed-content-digest.js';
import type {SqliteCommandContext,SqliteValidatorReader} from './command-context.js';
export type LifecycleReader=Pick<SqliteValidatorReader,'get'|'iterate'>;
export const regressionCopyBasis='Governed nonsealed truth copied into an immutable known-failure regression snapshot; not sealed calibration evidence.';
export function insertLifecycleRow(c:SqliteCommandContext,table:string,row:Record<string,SQLInputValue>){c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));}
export function ensureLifecycleOwner(c:SqliteCommandContext,actor:EvaluatorLifecycleAccess){
 if(!c.db.prepare("SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role='owner'").get(actor.projectId,actor.userId))throw repoError('forbidden','Only a current project owner may change evaluator lifecycle');
 const prior=c.db.prepare('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?').get(actor.projectId,actor.userId);if(prior)return String(prior.id);
 const id=`grs_${createHash('sha256').update(`${actor.projectId}\0${actor.userId}`).digest('hex').slice(0,48)}`;
 insertLifecycleRow(c,'governed_reviewer_subjects',{id,project_id:actor.projectId,account_user_id:actor.userId,subject_digest:governedContentV1Digest('governed-reviewer-subject/v1',{projectId:actor.projectId,subjectId:id}),created_at:c.timestamp});return id;
}
export function loadCandidateContext(read:LifecycleReader,projectId:string,input:EvaluatorCandidateCreateInput){
 const row=read.get(`SELECT p.id promotion_id,b.content_digest batch_digest,r.revision_digest truth_revision_digest,r.content_digest truth_content_digest,r.item_count truth_item_count
 FROM analysis_criterion_promotions p JOIN analysis_promotion_finalizations pf ON pf.promotion_id=p.id
 JOIN governed_review_batches b ON b.id=? AND b.project_id=p.project_id AND b.criterion_version_id=p.criterion_version_id AND b.role_intent IN('analysis_authoring','iterative_development')
 JOIN governed_review_batch_states s ON s.batch_id=b.id AND s.state='frozen'
 JOIN governed_review_batch_events e ON e.batch_id=b.id AND e.event_kind='frozen' AND e.dataset_revision_id=?
 JOIN dataset_revisions r ON r.id=e.dataset_revision_id AND r.project_id=b.project_id AND r.criterion_version_id=b.criterion_version_id AND r.role IN('analysis_authoring','iterative_development') AND r.provenance_level='governed_blind'
 JOIN dataset_revision_finalizations rf ON rf.revision_id=r.id
 WHERE p.project_id=? AND p.criterion_id=? AND p.criterion_version_id=?`,input.governedBatchId,input.truthDatasetRevisionId,projectId,input.criterionId,input.criterionVersionId);
 if(!row)throw repoError('candidate_provenance_conflict','Candidate source batch is not exact frozen governed nonsealed truth for the promoted criterion');
 if(row.batch_digest!==input.expectedBatchDigest)throw repoError('candidate_provenance_conflict','Governed batch digest changed');
 if(row.truth_revision_digest!==input.expectedTruthRevisionDigest||row.truth_content_digest!==input.expectedTruthContentDigest)throw repoError('truth_conflict','Frozen truth revision digest does not match the request');
 if(Number(row.truth_item_count)<1)throw repoError('truth_conflict','Frozen truth revision is empty');return row;
}
export function truthItems(read:LifecycleReader,projectId:string,revisionId:string){return read.iterate(`SELECT i.*,t.id truth_link_id FROM dataset_revision_items i JOIN governed_dataset_truth_links t ON t.dataset_revision_item_id=i.id AND t.dataset_revision_id=i.revision_id AND t.project_id=i.project_id AND t.resolved_label=i.reference_label WHERE i.project_id=? AND i.revision_id=? AND i.reference_label IN('pass','fail') ORDER BY i.position,i.id`,projectId,revisionId);}
export function candidateSeed(input:{lifecycleId:string;projectId:string;criterionId:string;skillVersionId:string;userId:string;subjectId:string},id=`elce_${randomUUID()}`):Omit<EvaluatorLifecycleEvent,'contentDigest'|'occurredAt'>{
 return {id,contractVersion:EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION,lifecycleId:input.lifecycleId,projectId:input.projectId,criterionId:input.criterionId,skillVersionId:input.skillVersionId,sequence:'1',transition:'candidate_created',state:'candidate',predecessorEventId:null,predecessorEventDigest:null,activationBundleId:null,activationEvidence:null,replacedSkillVersionId:null,actorUserId:input.userId,actorSubjectId:input.subjectId,actorRole:'owner',reason:'Candidate created from exact frozen governed nonsealed truth.',idempotencyKey:`candidate-created:${input.lifecycleId}`,requestDigest:evaluatorLifecycleDigest({basis:'evaluator-lifecycle-candidate-created-request/v1',lifecycleId:input.lifecycleId,skillVersionId:input.skillVersionId})};
}
export function insertLifecycleEvent(c:SqliteCommandContext,event:Omit<EvaluatorLifecycleEvent,'contentDigest'|'occurredAt'>){
 const a=event.activationEvidence;
 const row={id:event.id,contract_version:event.contractVersion,lifecycle_id:event.lifecycleId,project_id:event.projectId,criterion_id:event.criterionId,skill_version_id:event.skillVersionId,sequence:BigInt(event.sequence),transition:event.transition,state:event.state,predecessor_event_id:event.predecessorEventId,predecessor_event_digest:event.predecessorEventDigest,activation_bundle_id:event.activationBundleId,calibration_artifact_id:a?.calibrationArtifactId??null,calibration_artifact_digest:a?.calibrationArtifactDigest??null,calibration_evidence_digest:a?.calibrationEvidenceDigest??null,regression_run_id:a?.regressionRunId??null,regression_dataset_revision_id:a?.regressionDatasetRevisionId??null,replaced_skill_version_id:event.replacedSkillVersionId,actor_user_id:event.actorUserId,actor_subject_id:event.actorSubjectId,actor_role:event.actorRole,reason:event.reason,idempotency_key:event.idempotencyKey,request_digest:event.requestDigest,content_digest:evaluatorLifecycleEventContentDigest(event),occurred_at:c.timestamp};
 insertLifecycleRow(c,'evaluator_lifecycle_events',row);return rowToEvent({...row,sequence:event.sequence});
}
