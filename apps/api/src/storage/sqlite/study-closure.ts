import { randomUUID,createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AnalysisStudyEventResultSchema,type AnalysisStudyEventArtifact } from '@rubrist/shared';
import { AnalysisStudyRepositoryError } from '../../analysis-study/repository.js';
import { rowToStudyEvent } from '../../analysis-study/storage-values.js';
import * as evidence from '../../lib/analysis-study.js';
import { analysisPopulationDigest } from '../../lib/analysis-population.js';
import type { SqliteCommandContext } from './command-context.js';
import { recomputedPopulationFrame } from './population-validator.js';
import { studyProjection,studyItemProjection } from './study-projections.js';
import { insertStudyRecord } from './study-write.js';
import { clearStudyDeadlineFailure } from './study-deadlines.js';

export interface StudyClosureInput {
 projectId:string;studyId:string;idempotencyKey:string;requestDigest:string;
 closeCause:'server_deadline'|'explicit_owner_close';closeActorUserId:string|null;
 closeActorSubjectId:string|null;closeReason:string|null;expectedVersion:string;
}

/** Synchronous complete bundle under the caller's owning command. */
export function materializeStudyClosure(db:DatabaseSync,c:SqliteCommandContext,input:StudyClosureInput){
 const projectId=input.projectId,studyId=input.studyId;
 const head=studyProjection(db,projectId,studyId);if(!head)throw new AnalysisStudyRepositoryError('analysis_study_not_found','Analysis study not found');
 const replayQuery=db.prepare('SELECT * FROM analysis_study_events WHERE project_id=? AND study_id=? AND idempotency_key=?');
 replayQuery.setReadBigInts(true);
 const prior=replayQuery.get(projectId,studyId,input.idempotencyKey);
 if(prior){
  if(prior.request_digest!==input.requestDigest)throw new AnalysisStudyRepositoryError('analysis_study_idempotency_conflict','Study event key was reused with different input');
  return AnalysisStudyEventResultSchema.parse({study:head,event:rowToStudyEvent(prior),replayed:true});
 }
 if(head.state!=='coding_open'||!head.stoppingRule||head.stoppingRule.kind!==input.closeCause||head.currentVersion!==input.expectedVersion)throw new AnalysisStudyRepositoryError('analysis_study_state_conflict','Study is not at the requested closure head');
 const population=db.prepare('SELECT * FROM analysis_populations WHERE project_id=? AND id=?').get(projectId,head.study.populationId)!;
 const draw=db.prepare('SELECT * FROM analysis_population_draws WHERE project_id=? AND id=?').get(projectId,head.study.drawId)!;
 const effectiveClosedAt=head.stoppingRule.closeAt??c.timestamp;
 const items=db.prepare('SELECT id FROM analysis_study_items WHERE project_id=? AND study_id=? ORDER BY position').all(projectId,studyId).map(row=>{
  const p=studyItemProjection(db,projectId,studyId,String(row.id),effectiveClosedAt)!;
  const item={studyId,studyItemId:p.item.id,drawItemId:p.item.drawItemId,caseId:p.item.caseId,position:p.item.position,itemState:p.state,itemEventVersion:p.currentVersion,currentEventId:p.currentEventId,currentEventDigest:p.currentEventDigest,
   viewEventIds:p.viewEventIds,viewEventDigests:p.viewEventDigests,activeFailureObservationEventIds:p.activeFailureObservationEventIds,activeFailureObservationEventDigests:p.activeFailureObservationEventDigests,activeFailureAssignmentEventIds:p.activeFailureAssignmentEventIds,activeFailureAssignmentEventDigests:p.activeFailureAssignmentEventDigests,activeNoFailureEventId:p.activeNoFailureEventId,activeNoFailureEventDigest:p.activeNoFailureEventDigest,completionEventId:p.completionEventId,completionEventDigest:p.completionEventDigest};
  return {...item,contentDigest:evidence.analysisStudyClosureItemContentDigest(item)};
 });
 if(items.length!==Number(draw.fixed_budget))throw new AnalysisStudyRepositoryError('analysis_study_closure_conflict','Closure could not snapshot every selected draw item');
 const frozenFrameDigest=String(population.frame_digest),frozenDrawDigest=String(draw.draw_digest);
 const recomputedFrameDigest=recomputedPopulationFrame({get:(sql,...args)=>db.prepare(sql).get(...args),iterate:(sql,...args)=>db.prepare(sql).iterate(...args)},head.study.populationId);
 const recomputedDrawDigest=analysisPopulationDigest({basis:'rubrist-analysis-draw/v1',algorithmVersion:draw.algorithm_version,contentDigest:draw.content_digest,datasetRevisionId:draw.dataset_revision_id,drawExecutor:draw.draw_executor,drawItemContentDigests:db.prepare('SELECT content_digest FROM analysis_population_draw_items WHERE draw_id=? ORDER BY position').all(head.study.drawId).map(r=>r.content_digest),fixedBudget:draw.fixed_budget,frameDigest:frozenFrameDigest,inclusionProbability:{denominator:draw.inclusion_denominator,numerator:draw.inclusion_numerator},method:draw.method,populationId:draw.population_id,populationSize:draw.population_size,rngVersion:draw.rng_version,seed:draw.seed,stoppingRule:draw.stopping_rule});
 const assessment=evidence.deriveAnalysisStudyRepresentativeAssessment({populationId:head.study.populationId,methodEligible:draw.method==='simple_random',frozenFrameDigest,recomputedFrameDigest,frozenDrawDigest,recomputedDrawDigest,selectedItemCount:Number(draw.fixed_budget),closureItems:items});
 const artifact={studyId,populationId:head.study.populationId,drawId:head.study.drawId,datasetRevisionId:head.study.datasetRevisionId,stoppingRule:head.stoppingRule,closeCause:input.closeCause,closeActorUserId:input.closeActorUserId,closeActorSubjectId:input.closeActorSubjectId,closeActorRole:input.closeCause==='server_deadline'?'system' as const:'owner' as const,closeReason:input.closeReason,effectiveClosedAt,recordedAt:c.timestamp,
  selectedItemCount:items.length,viewedItemCount:items.filter(i=>i.viewEventIds.length).length,completedItemCount:items.filter(i=>i.itemState==='completed').length,viewSetDigest:evidence.analysisStudyViewSetDigest(items.flatMap(i=>i.viewEventDigests)),...assessment,method:String(draw.method),frozenFrameDigest,recomputedFrameDigest,frozenDrawDigest,recomputedDrawDigest,closureItemCount:items.length,contentDigest:evidence.analysisStudyClosureContentDigest(items.map(i=>i.contentDigest))};
 const closureId='asc_'+randomUUID(),closureDigest=evidence.analysisStudyClosureDigest(artifact);
 const {stoppingRule,...fields}=artifact;
 insertStudyRecord(c,'analysis_study_closures',{id:closureId,projectId,...fields,stoppingRule:stoppingRule.kind,closeAt:stoppingRule.closeAt,closureDigest,createdAt:c.timestamp,createdCommandToken:c.token});
 for(const item of items)insertStudyRecord(c,'analysis_study_closure_items',{id:'asci_'+randomUUID(),projectId,closureId,...item,createdAt:c.timestamp});
 const event:Omit<Extract<AnalysisStudyEventArtifact,{eventType:'coding_closed'}>,'eventDigest'>={id:'ase_'+randomUUID(),projectId,studyId,version:String(BigInt(head.currentVersion)+1n),predecessorEventId:head.currentEventId,predecessorEventDigest:head.currentEventDigest,eventType:'coding_closed',fromState:'coding_open',toState:'coding_closed',stoppingRule:null,closeCause:input.closeCause,closureId,closureDigest,expectedClosureDigest:null,reason:input.closeReason,actorSubjectId:input.closeActorSubjectId,actorUserId:input.closeActorUserId,actorRole:artifact.closeActorRole,idempotencyKey:input.idempotencyKey,requestDigest:input.requestDigest,occurredAt:c.timestamp};
 const completeEvent={...event,eventDigest:evidence.analysisStudyEventDigest(event)};
 insertStudyRecord(c,'analysis_study_events',{...completeEvent,closeAt:null});
 insertStudyRecord(c,'analysis_study_closure_finalizations',{closureId,projectId,commandToken:c.token});
 clearStudyDeadlineFailure(c,projectId,studyId);
 return AnalysisStudyEventResultSchema.parse({study:studyProjection(db,projectId,studyId),event:completeEvent,replayed:false});
}

export function closeStudyIfDue(db:DatabaseSync,c:SqliteCommandContext,projectId:string,studyId:string):boolean {
 const head=studyProjection(db,projectId,studyId);
 if(!head||head.state!=='coding_open'||head.stoppingRule?.kind!=='server_deadline'||head.stoppingRule.closeAt>c.timestamp)return false;
 const idempotencyKey='analysis-deadline-close_'+createHash('sha256').update([studyId,head.stoppingRule.closeAt].join('\0'),'utf8').digest('hex').slice(0,32);
 materializeStudyClosure(db,c,{projectId,studyId,idempotencyKey,requestDigest:evidence.analysisStudyEventRequestDigest({studyId,expectedVersion:head.currentVersion,eventType:'coding_closed',reason:null}),closeCause:'server_deadline',closeActorUserId:null,closeActorSubjectId:null,closeReason:null,expectedVersion:head.currentVersion});
 return true;
}
