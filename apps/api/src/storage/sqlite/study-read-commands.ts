import type { DatabaseSync } from 'node:sqlite';
import { AnalysisStudyDetailSchema,AnalysisStudySummariesPageSchema,AnalysisStudyItemsPageSchema,AnalysisStudyItemEventsPageSchema,AnalysisTaxonomyDetailSchema,AnalysisTaxonomyRevisionsPageSchema,AnalysisObservationAssignmentsPageSchema } from '@rubrist/shared';
import type { AnalysisStudyRepository,AnalysisStudyAccess } from '../../analysis-study/repository.js';
import * as values from '../../analysis-study/storage-values.js';
import * as projection from './study-projections.js';
import { studyWrite,studyAccess,ensureStudyDueClosure,studyPageLimit,encodeStudyCursor,decodeStudyCursor } from './study-support.js';
import { dueStudyCandidates,recordStudyDeadlineFailure,clearStudyDeadlineFailure } from './study-deadlines.js';
import { closeStudyIfDue } from './study-closure.js';
type Args<K extends keyof AnalysisStudyRepository>=Parameters<AnalysisStudyRepository[K]>;

export function sqliteStudyReadCommands(db:DatabaseSync,clock=Date.now){
 function read<T>(access:AnalysisStudyAccess,body:()=>T,studyId?:string):T {
  // Validate membership before deadline effects; recheck it with the final read.
  studyWrite(db,()=>studyAccess(db,access),clock);
  if(studyId!==undefined)ensureStudyDueClosure(db,access.projectId,studyId,clock);
  try{return studyWrite(db,c=>{studyAccess(db,access);if(studyId!==undefined)closeStudyIfDue(db,c,access.projectId,studyId);return body();},clock);}
  catch(error){if(studyId!==undefined){try{ensureStudyDueClosure(db,access.projectId,studyId,clock);}catch{/* Preserve original read failure after retry recording. */}}throw error;}
 }
 const itemExists=(projectId:string,studyId:string,itemId:string)=>Boolean(db.prepare('SELECT 1 FROM analysis_study_items WHERE project_id=? AND study_id=? AND id=?').get(projectId,studyId,itemId));
 return {
  studyGet(...[access,studyId]:Args<'getStudy'>){return read(access,()=>{
   const summary=projection.studySummary(db,access.projectId,studyId);if(!summary)return null;
   const taxonomy=projection.taxonomyArtifact(db,access.projectId),revision=taxonomy?projection.taxonomyRevisionProjection(db,access.projectId,taxonomy.id):null;
   return AnalysisStudyDetailSchema.parse({summary,taxonomyCoverage:revision?projection.studyCoverage(db,access.projectId,studyId,revision.revision.id):null});
  },studyId);},
  studyList(...[access,page]:Args<'listStudies'>){
   const size=studyPageLimit(page.limit),cursor=decodeStudyCursor(page.cursor,'chronological');
   const window=studyWrite(db,c=>{studyAccess(db,access);return db.prepare(`SELECT s.id,s.created_at,(r.next_retry_at>?) deferred FROM analysis_studies s
    LEFT JOIN analysis_study_deadline_retry_state r ON r.study_id=s.id AND r.project_id=s.project_id
    WHERE s.project_id=? AND (? IS NULL OR (s.created_at,governed_utf16_sort_key_v1(s.id))<(?,governed_utf16_sort_key_v1(?)))
    ORDER BY s.created_at DESC,governed_utf16_sort_key_v1(s.id) DESC LIMIT ?`).all(c.timestamp,access.projectId,cursor?.primary??null,cursor?.primary??null,cursor?.id??'',size+1);},clock);
   const available:string[]=[];let unavailableDueClosureCount=0;
   for(const row of window.slice(0,size)){
    if(row.deferred===1){unavailableDueClosureCount++;continue;}
    try{ensureStudyDueClosure(db,access.projectId,String(row.id),clock);available.push(String(row.id));}catch{unavailableDueClosureCount++;}
   }
   return read(access,()=>AnalysisStudySummariesPageSchema.parse({items:available.map(id=>projection.studySummary(db,access.projectId,id)).filter(x=>x!==null),totalCount:String(db.prepare('SELECT CAST(count(*) AS TEXT) n FROM analysis_studies WHERE project_id=?').get(access.projectId)!.n),unavailableDueClosureCount,nextCursor:window.length>size?encodeStudyCursor({kind:'chronological',primary:String(window[size-1]!.created_at),id:String(window[size-1]!.id)}):null}));
  },
  studyItems(...[access,studyId,page]:Args<'listStudyItems'>){const size=studyPageLimit(page.limit),cursor=decodeStudyCursor(page.cursor,'position');return read(access,()=>{
   if(!projection.studyProjection(db,access.projectId,studyId))return null;
   const rows=db.prepare('SELECT id,position FROM analysis_study_items WHERE project_id=? AND study_id=? AND position>? ORDER BY position LIMIT ?').all(access.projectId,studyId,BigInt(cursor?.primary??'-1'),size+1);
   return AnalysisStudyItemsPageSchema.parse({items:rows.slice(0,size).map(r=>projection.studyItemProjection(db,access.projectId,studyId,String(r.id))),totalCount:Number(db.prepare('SELECT count(*) n FROM analysis_study_items WHERE project_id=? AND study_id=?').get(access.projectId,studyId)!.n),nextCursor:rows.length>size?encodeStudyCursor({kind:'position',primary:String(rows[size-1]!.position)}):null});
  },studyId);},
  studyItemGet(...[access,studyId,itemId]:Args<'getStudyItem'>){return read(access,()=>{const study=projection.studyProjection(db,access.projectId,studyId),item=projection.studyItemProjection(db,access.projectId,studyId,itemId);return study&&item?{study,item}:null;},studyId);},
  studyItemEvents(...[access,studyId,itemId,page]:Args<'listStudyItemEvents'>){const size=studyPageLimit(page.limit),cursor=decodeStudyCursor(page.cursor,'version');return read(access,()=>{
   if(!itemExists(access.projectId,studyId,itemId))return null;
   const q=db.prepare('SELECT * FROM analysis_study_item_events WHERE project_id=? AND study_id=? AND study_item_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?');q.setReadBigInts(true);
   const bound=cursor?BigInt(cursor.primary):null,rows=q.all(access.projectId,studyId,itemId,bound,bound,size+1);
   return AnalysisStudyItemEventsPageSchema.parse({items:rows.slice(0,size).map(values.rowToStudyItemEvent),totalCount:String(db.prepare('SELECT CAST(count(*) AS TEXT) n FROM analysis_study_item_events WHERE project_id=? AND study_id=? AND study_item_id=?').get(access.projectId,studyId,itemId)!.n),nextCursor:rows.length>size?encodeStudyCursor({kind:'version',primary:String(rows[size-1]!.version)}):null});
  },studyId);},
  studyTaxonomyGet(...[access]:Args<'getTaxonomy'>){return read(access,()=>{const taxonomy=projection.taxonomyArtifact(db,access.projectId);if(!taxonomy)return null;return AnalysisTaxonomyDetailSchema.parse({taxonomy,revision:projection.taxonomyRevisionProjection(db,access.projectId,taxonomy.id)});});},
  studyTaxonomyRevisions(...[access,taxonomyId,page]:Args<'listTaxonomyRevisions'>){const size=studyPageLimit(page.limit),cursor=decodeStudyCursor(page.cursor,'sequence');return read(access,()=>{
   if(!projection.taxonomyArtifact(db,access.projectId,taxonomyId))return null;
   const rows=db.prepare('SELECT * FROM analysis_failure_taxonomy_revisions WHERE project_id=? AND taxonomy_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(access.projectId,taxonomyId,cursor?.primary??null,cursor?.primary??null,size+1);
   return AnalysisTaxonomyRevisionsPageSchema.parse({items:rows.slice(0,size).map(values.rowToTaxonomyRevision),totalCount:Number(db.prepare('SELECT count(*) n FROM analysis_failure_taxonomy_revisions WHERE project_id=? AND taxonomy_id=?').get(access.projectId,taxonomyId)!.n),nextCursor:rows.length>size?encodeStudyCursor({kind:'sequence',primary:String(rows[size-1]!.sequence)}):null});
  });},
  studyTaxonomyRevisionGet(...[access,taxonomyId,revisionId]:Args<'getTaxonomyRevision'>){return read(access,()=>projection.taxonomyRevisionProjection(db,access.projectId,taxonomyId,revisionId));},
  studyAssignments(...[access,taxonomyId,observationId,page]:Args<'listObservationAssignments'>){const size=studyPageLimit(page.limit),cursor=decodeStudyCursor(page.cursor,'version');
   const target=read(access,()=>db.prepare("SELECT e.study_id FROM analysis_study_item_events e JOIN analysis_failure_taxonomies t ON t.project_id=e.project_id WHERE e.project_id=? AND e.id=? AND e.event_type='failure_observed' AND t.id=?").get(access.projectId,observationId,taxonomyId));if(!target)return null;
   return read(access,()=>{
   if(!projection.taxonomyArtifact(db,access.projectId,taxonomyId))return null;
   const observation=db.prepare("SELECT study_id FROM analysis_study_item_events WHERE project_id=? AND id=? AND event_type='failure_observed'").get(access.projectId,observationId);if(!observation)return null;
   const q=db.prepare('SELECT * FROM analysis_observation_assignment_events WHERE project_id=? AND taxonomy_id=? AND observation_event_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?');q.setReadBigInts(true);
   const bound=cursor?BigInt(cursor.primary):null,rows=q.all(access.projectId,taxonomyId,observationId,bound,bound,size+1);
   return AnalysisObservationAssignmentsPageSchema.parse({items:rows.slice(0,size).map(values.rowToAssignmentEvent),totalCount:String(db.prepare('SELECT CAST(count(*) AS TEXT) n FROM analysis_observation_assignment_events WHERE project_id=? AND taxonomy_id=? AND observation_event_id=?').get(access.projectId,taxonomyId,observationId)!.n),nextCursor:rows.length>size?encodeStudyCursor({kind:'version',primary:String(rows[size-1]!.version)}):null});
  },String(target.study_id));},
  studyCoverage(...[access,studyId,revisionId]:Args<'getTaxonomyCoverage'>){return read(access,()=>projection.studyCoverage(db,access.projectId,studyId,revisionId),studyId);},
  studyCloseDue(...[limit]:Args<'closeDueStudies'>){let closed=0,failed=0;
   for(const row of dueStudyCandidates(db,limit,clock)){
    try{if(studyWrite(db,c=>{const result=closeStudyIfDue(db,c,row.projectId,row.studyId);clearStudyDeadlineFailure(c,row.projectId,row.studyId);return result;},clock))closed++;}
    catch{failed++;try{recordStudyDeadlineFailure(db,row.projectId,row.studyId,clock);}catch{/* Continue healthy studies in this bounded pass. */}}
   }
   if(failed)console.error('analysis study deadline closure partial failure');return closed;
  }
 };
}
