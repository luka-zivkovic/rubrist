import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AnalysisObservationAssignmentEventInputSchema,AnalysisObservationAssignmentEventResultSchema,AnalysisObservationAssignmentEventArtifactSchema } from '@rubrist/shared';
import type { AnalysisStudyRepository } from '../../analysis-study/repository.js';
import { rowToAssignmentEvent } from '../../analysis-study/storage-values.js';
import * as evidence from '../../lib/analysis-study.js';
import { studyAccess,studySubject,studyWrite,studyError,ensureStudyDueClosure } from './study-support.js';
import { closeStudyIfDue } from './study-closure.js';
import { insertStudyRecord } from './study-write.js';
import type { SqliteCommandContext } from './command-context.js';
export function sqliteStudyAssignmentCommands(db:DatabaseSync,clock=Date.now){
 const write=<T>(body:(c:SqliteCommandContext)=>T)=>studyWrite(db,body,clock);
 return {
  studyAssignmentAppend(...[actor,taxonomyId,raw]:Parameters<AnalysisStudyRepository['appendObservationAssignment']>){
   const input=AnalysisObservationAssignmentEventInputSchema.parse(raw),requestDigest=evidence.analysisAssignmentRequestDigest(input);
   const replay=()=>{
    const q=db.prepare('SELECT * FROM analysis_observation_assignment_events WHERE project_id=? AND taxonomy_id=? AND observation_event_id=? AND idempotency_key=?');q.setReadBigInts(true);
    const row=q.get(actor.projectId,taxonomyId,input.observationEventId,input.idempotencyKey);if(!row)return null;
    if(row.request_digest!==requestDigest)throw studyError('analysis_study_idempotency_conflict','Assignment key was reused with different input');
    return AnalysisObservationAssignmentEventResultSchema.parse({event:rowToAssignmentEvent(row),replayed:true});
   };
   const prior=write(()=>{studyAccess(db,actor);return replay();});if(prior)return prior;
   const observation=db.prepare('SELECT study_id FROM analysis_study_item_events WHERE project_id=? AND id=?').get(actor.projectId,input.observationEventId);
   const studyId=observation?String(observation.study_id):null;
   if(studyId)ensureStudyDueClosure(db,actor.projectId,studyId,clock);
   let result;
   try{result=write(c=>{
    studyAccess(db,actor);const repeated=replay();if(repeated)return repeated;
    const target=db.prepare(`SELECT o.study_id,o.study_item_id,r.sequence FROM analysis_study_item_events o JOIN analysis_failure_taxonomy_revisions r ON r.id=? AND r.project_id=o.project_id
     WHERE o.project_id=? AND o.id=? AND o.event_type='failure_observed' AND r.taxonomy_id=?`).get(input.taxonomyRevisionId,actor.projectId,input.observationEventId,taxonomyId);
    if(!target)throw studyError('analysis_assignment_conflict','Assignment target observation or taxonomy revision not found');
    if(closeStudyIfDue(db,c,actor.projectId,String(target.study_id)))return null;
    const parsed=AnalysisObservationAssignmentEventArtifactSchema.parse({id:'aoae_'+randomUUID(),projectId:actor.projectId,studyId:String(target.study_id),studyItemId:String(target.study_item_id),observationEventId:input.observationEventId,version:String(BigInt(input.expectedVersion)+1n),predecessorEventId:input.expectedPredecessorEventId,predecessorEventDigest:input.expectedPredecessorEventDigest,eventType:input.eventType,taxonomyId,taxonomyRevisionId:input.taxonomyRevisionId,taxonomyRevisionSequence:Number(target.sequence),codeId:input.codeId,rationale:input.rationale,actorSubjectId:studySubject(db,c,actor),actorUserId:actor.userId,actorRole:actor.projectRole,idempotencyKey:input.idempotencyKey,requestDigest,eventDigest:'sha256:'+'0'.repeat(64),occurredAt:c.timestamp});
    const {eventDigest:_placeholder,...basis}=parsed,event={...basis,eventDigest:evidence.analysisAssignmentEventDigest(basis)};
    insertStudyRecord(c,'analysis_observation_assignment_events',event);
    return AnalysisObservationAssignmentEventResultSchema.parse({event,replayed:false});
   });}catch(error){if(studyId){try{ensureStudyDueClosure(db,actor.projectId,studyId,clock);}catch{/* Preserve original failure. */}}throw error;}
   if(!result)throw studyError('analysis_study_state_conflict','Study deadline closed coding before this assignment');return result;
  }
 };
}
