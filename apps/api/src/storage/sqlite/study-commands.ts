import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AnalysisStudyCreateInputSchema,AnalysisStudyCreateResultSchema,AnalysisStudyOpenInputSchema,AnalysisStudyCompleteInputSchema,AnalysisStudyAbandonInputSchema,AnalysisStudyCloseInputSchema,AnalysisStudyEventResultSchema,AnalysisStudyEventArtifactSchema } from '@rubrist/shared';
import type { AnalysisStudyRepository,AnalysisStudyActor } from '../../analysis-study/repository.js';
import { rowToStudyEvent } from '../../analysis-study/storage-values.js';
import * as evidence from '../../lib/analysis-study.js';
import { studyAccess,studySubject,studyWrite,studyError,ensureStudyDueClosure } from './study-support.js';
import { studyProjection } from './study-projections.js';
import { insertStudyRecord } from './study-write.js';
import { materializeStudyClosure,closeStudyIfDue } from './study-closure.js';
import type { SqliteCommandContext } from './command-context.js';
type Args<K extends keyof AnalysisStudyRepository>=Parameters<AnalysisStudyRepository[K]>;

export function sqliteStudyCommands(db:DatabaseSync,clock=Date.now){
 const write=<T>(body:(c:SqliteCommandContext)=>T)=>studyWrite(db,body,clock);
 function deadlineWrite<T>(projectId:string,studyId:string,body:(c:SqliteCommandContext)=>T):T {
  try{return write(body);}catch(error){try{ensureStudyDueClosure(db,projectId,studyId,clock);}catch{/* Preserve original command failure after durable retry recording. */}throw error;}
 }
 function replay(projectId:string,studyId:string,key:string,digest:string){
  const q=db.prepare('SELECT * FROM analysis_study_events WHERE project_id=? AND study_id=? AND idempotency_key=?');q.setReadBigInts(true);const row=q.get(projectId,studyId,key);if(!row)return null;
  if(row.request_digest!==digest)throw studyError('analysis_study_idempotency_conflict','Study event key was reused with different input');
  return AnalysisStudyEventResultSchema.parse({study:studyProjection(db,projectId,studyId),event:rowToStudyEvent(row),replayed:true});
 }
 type Transition=evidence.AnalysisStudyEventRequestDigestInput & {idempotencyKey:string};
 function transition(actor:AnalysisStudyActor,input:Transition){
  const {idempotencyKey,...request}=input,studyId=input.studyId;
  const requestDigest=evidence.analysisStudyEventRequestDigest(request);
  const prior=write(()=>{studyAccess(db,actor,true);return replay(actor.projectId,studyId,idempotencyKey,requestDigest);});if(prior)return prior;
  ensureStudyDueClosure(db,actor.projectId,studyId,clock);
  const result=deadlineWrite(actor.projectId,studyId,c=>{
   studyAccess(db,actor,true);const repeated=replay(actor.projectId,studyId,idempotencyKey,requestDigest);if(repeated)return repeated;
   if(closeStudyIfDue(db,c,actor.projectId,studyId))return null;
   const head=studyProjection(db,actor.projectId,studyId);if(!head)throw studyError('analysis_study_not_found','Analysis study not found');
   if(head.currentVersion!==input.expectedVersion)throw studyError('analysis_study_version_conflict','Study compare-and-swap version does not match');
   const subjectId=studySubject(db,c,actor);
   const event=AnalysisStudyEventArtifactSchema.parse({id:'ase_'+randomUUID(),projectId:actor.projectId,studyId,version:String(BigInt(head.currentVersion)+1n),predecessorEventId:head.currentEventId,predecessorEventDigest:head.currentEventDigest,actorUserId:actor.userId,actorSubjectId:subjectId,actorRole:'owner',idempotencyKey,requestDigest,occurredAt:c.timestamp,eventType:input.eventType,
    fromState:input.eventType==='coding_opened'?'draft':input.eventType==='study_completed'?'coding_closed':head.state==='coding_open'?'coding_open':'draft',toState:input.eventType==='coding_opened'?'coding_open':input.eventType==='study_completed'?'completed':'abandoned',stoppingRule:'stoppingRule' in input?input.stoppingRule:null,closeCause:null,closureId:null,closureDigest:null,expectedClosureDigest:'expectedClosureDigest' in input?input.expectedClosureDigest:null,reason:'reason' in input?input.reason:null,eventDigest:'sha256:'+'0'.repeat(64)});
   const {eventDigest:_placeholder,...basis}=event;const complete={...basis,eventDigest:evidence.analysisStudyEventDigest(basis)};
   insertStudyRecord(c,'analysis_study_events',{...complete,stoppingRule:complete.stoppingRule?.kind??null,closeAt:complete.stoppingRule?.closeAt??null});
   return AnalysisStudyEventResultSchema.parse({study:studyProjection(db,actor.projectId,studyId),event:complete,replayed:false});
  });
  if(!result)throw studyError('analysis_study_state_conflict','Study deadline closed before this command');return result;
 }
 return {
  studyCreate(...[actor,raw]:Args<'createStudy'>){const input=AnalysisStudyCreateInputSchema.parse(raw);return write(c=>{
   studyAccess(db,actor,true);const subjectId=studySubject(db,c,actor),requestDigest=evidence.analysisStudyRequestDigest(actor.projectId,input.populationId);
   const prior=db.prepare('SELECT id,request_digest FROM analysis_studies WHERE project_id=? AND idempotency_key=?').get(actor.projectId,input.idempotencyKey);
   if(prior){if(prior.request_digest!==requestDigest)throw studyError('analysis_study_idempotency_conflict','Study key was reused with different input');return AnalysisStudyCreateResultSchema.parse({study:studyProjection(db,actor.projectId,String(prior.id)),reused:true});}
   const frame=db.prepare('SELECT p.id population_id,p.dataset_revision_id,d.id draw_id FROM analysis_populations p JOIN analysis_population_draws d ON d.population_id=p.id AND d.project_id=p.project_id WHERE p.project_id=? AND p.id=?').get(actor.projectId,input.populationId);
   if(!frame)throw studyError('analysis_study_not_found','Analysis population not found');
   const existing=db.prepare('SELECT id FROM analysis_studies WHERE project_id=? AND draw_id=?').get(actor.projectId,frame.draw_id!);
   if(existing)throw studyError('analysis_study_draw_conflict','The selected draw already has its permanent analysis study',{studyId:String(existing.id)});
   const id='as_'+randomUUID(),basis={projectId:actor.projectId,populationId:input.populationId,drawId:String(frame.draw_id),datasetRevisionId:String(frame.dataset_revision_id),contractVersion:'analysis-study/v1' as const};
   insertStudyRecord(c,'analysis_studies',{id,...basis,idempotencyKey:input.idempotencyKey,requestDigest,contentDigest:evidence.analysisStudyContentDigest(basis),createdByUserId:actor.userId,createdBySubjectId:subjectId,createdAt:c.timestamp,createdCommandToken:c.token});
   for(const d of db.prepare('SELECT * FROM analysis_population_draw_items WHERE project_id=? AND draw_id=? ORDER BY position').all(actor.projectId,basis.drawId)){
    const item={studyId:id,drawItemId:String(d.id),memberId:String(d.member_id),revisionItemId:String(d.revision_item_id),caseId:String(d.case_id),position:Number(d.position)};
    insertStudyRecord(c,'analysis_study_items',{id:'asi_'+randomUUID(),projectId:actor.projectId,...item,contentDigest:evidence.analysisStudyItemContentDigest(item),createdAt:c.timestamp});
   }
   insertStudyRecord(c,'analysis_study_finalizations',{studyId:id,projectId:actor.projectId,commandToken:c.token});
   return AnalysisStudyCreateResultSchema.parse({study:studyProjection(db,actor.projectId,id),reused:false});
  });},
  studyOpen(...[actor,studyId,raw]:Args<'openStudy'>){const input=AnalysisStudyOpenInputSchema.parse(raw);return transition(actor,{studyId,...input,eventType:'coding_opened'});},
  studyComplete(...[actor,studyId,raw]:Args<'completeStudy'>){const input=AnalysisStudyCompleteInputSchema.parse(raw);return transition(actor,{studyId,...input,eventType:'study_completed'});},
  studyAbandon(...[actor,studyId,raw]:Args<'abandonStudy'>){const input=AnalysisStudyAbandonInputSchema.parse(raw);return transition(actor,{studyId,...input,eventType:'study_abandoned'});},
  studyClose(...[actor,studyId,raw]:Args<'closeStudy'>){const input=AnalysisStudyCloseInputSchema.parse(raw),requestDigest=evidence.analysisStudyEventRequestDigest({studyId,expectedVersion:input.expectedVersion,eventType:'coding_closed',reason:input.reason});
   const prior=write(()=>{studyAccess(db,actor,true);return replay(actor.projectId,studyId,input.idempotencyKey,requestDigest);});if(prior)return prior;
   ensureStudyDueClosure(db,actor.projectId,studyId,clock);
   const result=deadlineWrite(actor.projectId,studyId,c=>{studyAccess(db,actor,true);if(closeStudyIfDue(db,c,actor.projectId,studyId))return null;
    return materializeStudyClosure(db,c,{projectId:actor.projectId,studyId,idempotencyKey:input.idempotencyKey,requestDigest,closeCause:'explicit_owner_close',closeActorUserId:actor.userId,closeActorSubjectId:studySubject(db,c,actor),closeReason:input.reason,expectedVersion:input.expectedVersion});});
   if(!result)throw studyError('analysis_study_state_conflict','Frozen server deadline closed the study before owner close');return result;
  }
 };
}
