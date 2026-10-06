import type { DatabaseSync } from 'node:sqlite';
import { AnalysisStudyItemArtifactSchema, AnalysisStudyItemProjectionSchema, AnalysisStudyClosureArtifactSchema, AnalysisStudySummarySchema, AnalysisTaxonomyRevisionProjectionSchema } from '@rubrist/shared';
import * as values from '../../analysis-study/storage-values.js';
import { computeAnalysisTaxonomyCoverage } from '../../lib/analysis-study.js';
import { camel } from './evaluation-values.js';

/** Call inside a read/write transaction when composing multiple projections. */
export function studyProjection(db:DatabaseSync,projectId:string,studyId:string){
 const row=db.prepare('SELECT * FROM analysis_studies WHERE project_id=? AND id=?').get(projectId,studyId);if(!row)return null;
 const head=db.prepare('SELECT id,to_state,event_digest,CAST(version AS TEXT) exact_version FROM analysis_study_events WHERE study_id=? ORDER BY version DESC LIMIT 1').get(studyId);
 const opened=db.prepare("SELECT stopping_rule,close_at FROM analysis_study_events WHERE study_id=? AND event_type='coding_opened'").get(studyId);
 const closed=db.prepare('SELECT id,closure_digest FROM analysis_study_closures WHERE study_id=?').get(studyId);
 return values.rowToStudyProjection({...row,study_id:row.id,study_created_at:row.created_at,state:head?.to_state??'draft',current_version:head?.exact_version??'0',current_event_id:head?.id??null,current_event_digest:head?.event_digest??null,stopping_rule:opened?.stopping_rule??null,close_at:opened?.close_at??null,closure_id:closed?.id??null,closure_digest:closed?.closure_digest??null});
}

export function studyItemProjection(db:DatabaseSync,projectId:string,studyId:string,itemId:string,asOf:string|null=null){
 const row=db.prepare('SELECT * FROM analysis_study_items WHERE project_id=? AND study_id=? AND id=?').get(projectId,studyId,itemId);if(!row)return null;
 const item=AnalysisStudyItemArtifactSchema.parse(camel(row));
 const head=db.prepare('SELECT id,event_digest,CAST(e.version AS TEXT) version FROM analysis_study_item_events e WHERE study_item_id=? AND (? IS NULL OR occurred_at<=?) ORDER BY e.version DESC LIMIT 1').get(itemId,asOf,asOf);
 const active=(type:string,withdrawal:string)=>db.prepare(`SELECT e.id,e.event_digest FROM analysis_study_item_events e WHERE e.study_item_id=? AND e.event_type=? AND (? IS NULL OR e.occurred_at<=?)
  AND NOT EXISTS(SELECT 1 FROM analysis_study_item_events w WHERE w.target_event_id=e.id AND w.event_type=? AND (? IS NULL OR w.occurred_at<=?)) ORDER BY e.version`).all(itemId,type,asOf,asOf,withdrawal,asOf,asOf);
 const failures=active('failure_observed','failure_withdrawn');
 const assignments=failures.map(e=>db.prepare('SELECT id,event_digest FROM analysis_observation_assignment_events WHERE observation_event_id=? ORDER BY version DESC LIMIT 1').get(e.id!));
 const noFailure=active('no_failure_observed','no_failure_withdrawn').at(-1),completion=active('coding_completed','coding_reopened').at(-1);
 const views=db.prepare('SELECT id,content_digest FROM analysis_study_item_views WHERE study_item_id=? AND counts_toward_closure=1 AND (? IS NULL OR viewed_at<=?) ORDER BY viewed_at,governed_utf16_sort_key_v1(id)').all(itemId,asOf,asOf);
 return AnalysisStudyItemProjectionSchema.parse({item,state:completion?'completed':head||views.length?'in_progress':'uncoded',currentVersion:head?.version??'0',currentEventId:head?.id??null,currentEventDigest:head?.event_digest??null,
  viewEventIds:views.map(v=>v.id),viewEventDigests:views.map(v=>v.content_digest),activeFailureObservationEventIds:failures.map(e=>e.id),activeFailureObservationEventDigests:failures.map(e=>e.event_digest),activeFailureAssignmentEventIds:assignments.map(a=>a?.id??null),activeFailureAssignmentEventDigests:assignments.map(a=>a?.event_digest??null),activeNoFailureEventId:noFailure?.id??null,activeNoFailureEventDigest:noFailure?.event_digest??null,completionEventId:completion?.id??null,completionEventDigest:completion?.event_digest??null});
}

export function studyClosure(db:DatabaseSync,projectId:string,studyId:string){
 const row=db.prepare('SELECT * FROM analysis_study_closures WHERE project_id=? AND study_id=?').get(projectId,studyId);if(!row)return null;
 const {createdCommandToken:_token,closeAt,stoppingRule,...fields}=camel(row);
 return AnalysisStudyClosureArtifactSchema.parse({...fields,stoppingRule:{kind:stoppingRule,closeAt},methodEligible:row.method_eligible===1,frameReproducible:row.frame_reproducible===1,drawComplete:row.draw_complete===1,codingComplete:row.coding_complete===1});
}

export function studySummary(db:DatabaseSync,projectId:string,studyId:string){
 const study=studyProjection(db,projectId,studyId);if(!study)return null;
 const closure=studyClosure(db,projectId,studyId);
 if(closure)return AnalysisStudySummarySchema.parse({study,closure,selectedItemCount:closure.selectedItemCount,viewedItemCount:closure.viewedItemCount,completedItemCount:closure.completedItemCount});
 const counts=db.prepare(`SELECT count(*) selected,
  coalesce(sum(EXISTS(SELECT 1 FROM analysis_study_item_views v WHERE v.study_item_id=i.id AND v.counts_toward_closure=1)),0) viewed,
  coalesce(sum(EXISTS(SELECT 1 FROM analysis_study_item_active_events e WHERE e.study_item_id=i.id AND e.event_type='coding_completed')),0) completed
  FROM analysis_study_items i WHERE i.study_id=?`).get(studyId)!;
 return AnalysisStudySummarySchema.parse({study,closure:null,selectedItemCount:counts.selected,viewedItemCount:counts.viewed,completedItemCount:counts.completed});
}

export function taxonomyArtifact(db:DatabaseSync,projectId:string,taxonomyId:string|null=null){
 const row=db.prepare('SELECT * FROM analysis_failure_taxonomies WHERE project_id=? AND (? IS NULL OR id=?)').get(projectId,taxonomyId,taxonomyId);return row?values.rowToTaxonomyArtifact(row):null;
}
export function taxonomyRevisionProjection(db:DatabaseSync,projectId:string,taxonomyId:string,revisionId:string|null=null){
 const row=db.prepare('SELECT * FROM analysis_failure_taxonomy_revisions WHERE project_id=? AND taxonomy_id=? AND (? IS NULL OR id=?) ORDER BY sequence DESC LIMIT 1').get(projectId,taxonomyId,revisionId,revisionId);if(!row)return null;
 return AnalysisTaxonomyRevisionProjectionSchema.parse({revision:values.rowToTaxonomyRevision(row),codes:db.prepare('SELECT * FROM analysis_failure_taxonomy_revision_codes WHERE project_id=? AND taxonomy_revision_id=? ORDER BY position').all(projectId,row.id!).map(values.rowToTaxonomyCode)});
}
export function studyCoverage(db:DatabaseSync,projectId:string,studyId:string,revisionId:string){
 if(!studyProjection(db,projectId,studyId))return null;
 const taxonomy=taxonomyArtifact(db,projectId);if(!taxonomy)return null;
 const targetRevision=taxonomyRevisionProjection(db,projectId,taxonomy.id,revisionId);if(!targetRevision)return null;
 const revisionAncestry=db.prepare('SELECT id,sequence FROM analysis_failure_taxonomy_revisions WHERE taxonomy_id=? AND sequence<=? ORDER BY sequence').all(taxonomy.id,targetRevision.revision.sequence).map(r=>({id:String(r.id),sequence:Number(r.sequence)}));
 const items=db.prepare('SELECT id FROM analysis_study_items WHERE project_id=? AND study_id=? ORDER BY position').all(projectId,studyId).map(row=>studyItemProjection(db,projectId,studyId,String(row.id))!);
 const assignmentQuery=db.prepare('SELECT * FROM analysis_observation_assignment_events WHERE project_id=? AND study_id=? ORDER BY version');
 assignmentQuery.setReadBigInts(true);
 const assignmentEvents=assignmentQuery.all(projectId,studyId).map(values.rowToAssignmentEvent);
 return computeAnalysisTaxonomyCoverage({studyId,taxonomy,targetRevision,revisionAncestry,items,assignmentEvents});
}
