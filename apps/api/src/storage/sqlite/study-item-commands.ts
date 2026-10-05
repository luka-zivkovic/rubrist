import { createHash,randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AnalysisStudyItemEventInputSchema,AnalysisStudyItemEventArtifactSchema,AnalysisStudyItemEventResultSchema,DatasetRevisionPayloadSnapshotSchema } from '@rubrist/shared';
import type { AnalysisStudyRepository } from '../../analysis-study/repository.js';
import { rowToStudyItemEvent } from '../../analysis-study/storage-values.js';
import * as evidence from '../../lib/analysis-study.js';
import { studyAccess,studySubject,studyWrite,studyError,ensureStudyDueClosure } from './study-support.js';
import { studyProjection,studyItemProjection } from './study-projections.js';
import { closeStudyIfDue } from './study-closure.js';
import { insertStudyRecord } from './study-write.js';
import type { SqliteCommandContext } from './command-context.js';
type Args<K extends keyof AnalysisStudyRepository>=Parameters<AnalysisStudyRepository[K]>;

export function sqliteStudyItemCommands(db:DatabaseSync,clock=Date.now){
 const write=<T>(body:(c:SqliteCommandContext)=>T)=>studyWrite(db,body,clock);
 function deadlineWrite<T>(projectId:string,studyId:string,body:(c:SqliteCommandContext)=>T):T {
  try{return write(body);}catch(error){try{ensureStudyDueClosure(db,projectId,studyId,clock);}catch{/* Preserve original failure. */}throw error;}
 }
 function replay(projectId:string,studyId:string,itemId:string,key:string,digest:string){
  const q=db.prepare('SELECT * FROM analysis_study_item_events WHERE project_id=? AND study_id=? AND study_item_id=? AND idempotency_key=?');q.setReadBigInts(true);const row=q.get(projectId,studyId,itemId,key);if(!row)return null;
  if(row.request_digest!==digest)throw studyError('analysis_study_idempotency_conflict','Study item key was reused with different input');
  return AnalysisStudyItemEventResultSchema.parse({item:studyItemProjection(db,projectId,studyId,itemId),event:rowToStudyItemEvent(row),replayed:true});
 }
 return {
  studyItemAppend(...[actor,studyId,itemId,raw]:Args<'appendStudyItemEvent'>){
   const input=AnalysisStudyItemEventInputSchema.parse(raw),requestDigest=evidence.analysisStudyItemEventRequestDigest(actor.projectId,studyId,itemId,input);
   const prior=write(()=>{studyAccess(db,actor);return replay(actor.projectId,studyId,itemId,input.idempotencyKey,requestDigest);});if(prior)return prior;
   ensureStudyDueClosure(db,actor.projectId,studyId,clock);
   const result=deadlineWrite(actor.projectId,studyId,c=>{
    studyAccess(db,actor);const repeated=replay(actor.projectId,studyId,itemId,input.idempotencyKey,requestDigest);if(repeated)return repeated;
    if(closeStudyIfDue(db,c,actor.projectId,studyId))return null;
    const study=studyProjection(db,actor.projectId,studyId),item=studyItemProjection(db,actor.projectId,studyId,itemId);
    if(!study||!item)throw studyError('analysis_study_not_found','Analysis study item not found');
    if(study.state!=='coding_open')throw studyError('analysis_study_state_conflict','Study coding is not open');
    if(item.currentVersion!==input.expectedVersion)throw studyError('analysis_study_version_conflict','Study item compare-and-swap version does not match');
    const {expectedVersion:_expected,...details}=input;
    const parsed=AnalysisStudyItemEventArtifactSchema.parse({...details,id:'asie_'+randomUUID(),projectId:actor.projectId,studyId,studyItemId:itemId,version:String(BigInt(item.currentVersion)+1n),predecessorEventId:item.currentEventId,predecessorEventDigest:item.currentEventDigest,actorUserId:actor.userId,actorSubjectId:studySubject(db,c,actor),actorRole:actor.projectRole,requestDigest,eventDigest:'sha256:'+'0'.repeat(64),occurredAt:c.timestamp});
    const {eventDigest:_digest,...basis}=parsed,event={...basis,eventDigest:evidence.analysisStudyItemEventDigest(basis)};
    const anchor='evidenceAnchor' in event?event.evidenceAnchor:null;
    insertStudyRecord(c,'analysis_study_item_events',{id:event.id,projectId:actor.projectId,studyId,studyItemId:itemId,version:event.version,predecessorEventId:event.predecessorEventId,predecessorEventDigest:event.predecessorEventDigest,eventType:event.eventType,targetEventId:'targetEventId' in event?event.targetEventId:null,targetEventDigest:'targetEventDigest' in event?event.targetEventDigest:null,failureLabel:'failureLabel' in event?event.failureLabel:null,rationale:'rationale' in event?event.rationale:null,anchorKind:anchor?.kind??null,anchorStepIndex:anchor?.kind==='step'?anchor.stepIndex:null,actorSubjectId:event.actorSubjectId,actorUserId:event.actorUserId,actorRole:event.actorRole,idempotencyKey:event.idempotencyKey,requestDigest,eventDigest:event.eventDigest,occurredAt:c.timestamp});
    return AnalysisStudyItemEventResultSchema.parse({item:studyItemProjection(db,actor.projectId,studyId,itemId),event,replayed:false});
   });
   if(!result)throw studyError('analysis_study_state_conflict','Study deadline closed coding before this command');return result;
  },
  studyItemContent(...[access,studyId,itemId]:Args<'getStudyItemContent'>){
   write(()=>studyAccess(db,access));ensureStudyDueClosure(db,access.projectId,studyId,clock);
   return deadlineWrite(access.projectId,studyId,c=>{
    studyAccess(db,access);closeStudyIfDue(db,c,access.projectId,studyId);
    const study=studyProjection(db,access.projectId,studyId);if(!study)return null;
    const row=db.prepare(`SELECT i.draw_item_id,i.member_id,i.revision_item_id,i.case_id,i.position,r.input_digest,r.item_digest,r.payload_snapshot
     FROM analysis_study_items i JOIN dataset_revision_items r ON r.id=i.revision_item_id AND r.project_id=i.project_id AND r.revision_id=? WHERE i.project_id=? AND i.study_id=? AND i.id=?`).get(study.study.datasetRevisionId,access.projectId,studyId,itemId);if(!row)return null;
    if(study.state==='draft'||study.state==='abandoned')throw studyError('analysis_study_state_conflict','Study content is unavailable in its current state');
    const subjectId=studySubject(db,c,access),revisionId=study.study.datasetRevisionId,populationId=study.study.populationId;
    const key=`analysis-content-view:${revisionId}:${subjectId}`;
    c.db.prepare(`INSERT INTO dataset_exposure_events(id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key,occurred_at)
     VALUES(?,?,?,NULL,'human_access','development','content_view','person',?,?,'analysis_population',?,'Governed Analyze study item content view',?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING`)
     .run('dse_'+randomUUID(),access.projectId,revisionId,subjectId,access.userId,populationId,JSON.stringify({contract:'rubrist/analysis-study-item-content-view/v1',studyId,studyItemId:itemId}),key,c.timestamp);
    const exposure=c.db.prepare('SELECT * FROM dataset_exposure_events WHERE project_id=? AND idempotency_key=?').get(access.projectId,key);
    if(!exposure||exposure.revision_id!==revisionId||exposure.revision_item_id!==null||exposure.kind!=='human_access'||exposure.exposure_class!=='development'||exposure.activity!=='content_view'||exposure.subject_kind!=='person'||exposure.subject_id!==subjectId||exposure.actor_user_id!==access.userId||exposure.evidence_ref_kind!=='analysis_population'||exposure.evidence_ref_id!==populationId)throw studyError('analysis_study_evidence_conflict','Dataset exposure did not converge on the exact study content read');
    const basis={projectId:access.projectId,studyId,studyItemId:itemId,viewerUserId:access.userId,viewerSubjectId:subjectId,datasetRevisionId:revisionId},requestDigest=evidence.analysisStudyItemViewRequestDigest(basis);
    let view=c.db.prepare('SELECT * FROM analysis_study_item_views WHERE project_id=? AND study_id=? AND study_item_id=? AND viewer_subject_id=?').get(access.projectId,studyId,itemId,subjectId);
    if(!view){
     const event={...basis,id:'asiv_'+randomUUID(),datasetExposureEventId:String(exposure.id),idempotencyKey:'analysis-study-view_'+createHash('sha256').update([studyId,itemId,subjectId].join('\0'),'utf8').digest('hex').slice(0,32),requestDigest,countsTowardClosure:study.state==='coding_open',viewedAt:c.timestamp};
     const {datasetRevisionId:_revision,...fields}=event;
     insertStudyRecord(c,'analysis_study_item_views',{...fields,contentDigest:evidence.analysisStudyItemViewContentDigest(event)});
     view=c.db.prepare('SELECT * FROM analysis_study_item_views WHERE id=?').get(event.id);
    }
    if(!view||view.request_digest!==requestDigest||view.dataset_exposure_event_id!==exposure.id)throw studyError('analysis_study_evidence_conflict','Study view did not converge on its exact governed exposure');
    return {projectId:access.projectId,studyId,populationId,drawId:study.study.drawId,datasetRevisionId:revisionId,studyItemId:itemId,drawItemId:String(row.draw_item_id),memberId:String(row.member_id),revisionItemId:String(row.revision_item_id),caseId:String(row.case_id),position:Number(row.position),inputDigest:String(row.input_digest),itemDigest:String(row.item_digest),viewEventId:String(view.id),datasetExposureEventId:String(exposure.id),payloadSnapshot:DatasetRevisionPayloadSnapshotSchema.parse(JSON.parse(String(row.payload_snapshot)))};
   });
  }
 };
}
