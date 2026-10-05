import * as study from '../../src/lib/analysis-study.js';
import { sqliteCommand } from '../../src/storage/sqlite/command-context.js';
import type { Fixture, Hook, RecordValue } from './sqlite-analysis.js';
import { camel } from '../../src/storage/sqlite/evaluation-values.js';
export function closeStudy(f:Fixture,options:{now?:number;frame?:string|null;hook?:Hook;after?:Parameters<typeof sqliteCommand>[1]}={}){
 return sqliteCommand(f.db,c=>{
  const insert=(table:string,row:RecordValue)=>{const r=options.hook?.(table,row,c)??(options.hook?null:row);if(!r)return;const keys=Object.keys(r);c.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(r));};
  const opened=f.db.prepare("SELECT * FROM analysis_study_events WHERE study_id='study' AND event_type='coding_opened'").get()!;
  const deadline=opened.stopping_rule==='server_deadline',effectiveClosedAt=deadline?String(opened.close_at):c.timestamp;
  const population=f.db.prepare("SELECT * FROM analysis_populations WHERE id='ap'").get()!,draw=f.db.prepare("SELECT * FROM analysis_population_draws WHERE id='draw'").get()!;
  const items=f.db.prepare("SELECT * FROM analysis_study_items WHERE study_id='study' ORDER BY position").all().map(row=>{
   let p=study.initialAnalysisStudyItemProjection(camel(row) as never);
   const events=f.db.prepare('SELECT *,CAST(version AS TEXT) version_text FROM analysis_study_item_events WHERE study_item_id=? AND occurred_at<=? ORDER BY version').all(row.id!,effectiveClosedAt);
   for(const e of events)p=study.applyAnalysisStudyItemEvent(p,{...camel(e),version:e.version_text} as never,'coding_open');
   const views=f.db.prepare('SELECT * FROM analysis_study_item_views WHERE study_item_id=? AND counts_toward_closure=1 AND viewed_at<=? ORDER BY viewed_at,governed_utf16_sort_key_v1(id)').all(row.id!,effectiveClosedAt);
   p.viewEventIds=views.map(v=>String(v.id));p.viewEventDigests=views.map(v=>String(v.content_digest));if(views.length&&p.state==='uncoded')p.state='in_progress';
   const assignments=p.activeFailureObservationEventIds.map(id=>f.db.prepare('SELECT id,event_digest FROM analysis_observation_assignment_events WHERE observation_event_id=? ORDER BY version DESC LIMIT 1').get(id));
   p.activeFailureAssignmentEventIds=assignments.map(a=>a?String(a.id):null);p.activeFailureAssignmentEventDigests=assignments.map(a=>a?String(a.event_digest):null);
   const item={studyId:'study',studyItemId:String(row.id),drawItemId:String(row.draw_item_id),caseId:String(row.case_id),position:Number(row.position),itemState:p.state,itemEventVersion:p.currentVersion,currentEventId:p.currentEventId,currentEventDigest:p.currentEventDigest,
    viewEventIds:p.viewEventIds,viewEventDigests:p.viewEventDigests,activeFailureObservationEventIds:p.activeFailureObservationEventIds,activeFailureObservationEventDigests:p.activeFailureObservationEventDigests,activeFailureAssignmentEventIds:p.activeFailureAssignmentEventIds,activeFailureAssignmentEventDigests:p.activeFailureAssignmentEventDigests,activeNoFailureEventId:p.activeNoFailureEventId,activeNoFailureEventDigest:p.activeNoFailureEventDigest,completionEventId:p.completionEventId,completionEventDigest:p.completionEventDigest};
   return {...item,contentDigest:study.analysisStudyClosureItemContentDigest(item)};
  });
  const frozenFrameDigest=String(population.frame_digest),recomputedFrameDigest=options.frame===undefined?frozenFrameDigest:options.frame,frozenDrawDigest=String(draw.draw_digest),recomputedDrawDigest=frozenDrawDigest;
  const assessment=study.deriveAnalysisStudyRepresentativeAssessment({populationId:'ap',methodEligible:true,frozenFrameDigest,recomputedFrameDigest,frozenDrawDigest,recomputedDrawDigest,selectedItemCount:2,closureItems:items});
  const artifact={studyId:'study',populationId:'ap',drawId:'draw',datasetRevisionId:'rev',stoppingRule:{kind:deadline?'server_deadline':'explicit_owner_close',closeAt:deadline?String(opened.close_at):null},closeCause:deadline?'server_deadline':'explicit_owner_close',closeActorUserId:deadline?null:f.userId,closeActorSubjectId:deadline?null:'subject',closeActorRole:deadline?'system':'owner',closeReason:deadline?null:'Owner closes study',effectiveClosedAt,recordedAt:c.timestamp,
   selectedItemCount:2,viewedItemCount:items.filter(i=>i.viewEventIds.length).length,completedItemCount:items.filter(i=>i.itemState==='completed').length,viewSetDigest:study.analysisStudyViewSetDigest(items.flatMap(i=>i.viewEventDigests)),...assessment,method:String(draw.method),frozenFrameDigest,recomputedFrameDigest,frozenDrawDigest,recomputedDrawDigest,closureItemCount:items.length,contentDigest:study.analysisStudyClosureContentDigest(items.map(i=>i.contentDigest))};
  const closureDigest=study.analysisStudyClosureDigest(artifact as never);
  const snake=(value:Record<string,unknown>):RecordValue=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/[A-Z]/g,m=>'_'+m.toLowerCase()),typeof v==='boolean'?Number(v):Array.isArray(v)?JSON.stringify(v):v])) as RecordValue;
  const {stoppingRule,...fields}=artifact;
  insert('analysis_study_closures',{id:'closure',project_id:f.projectId,...snake(fields),stopping_rule:stoppingRule.kind,close_at:stoppingRule.closeAt,closure_digest:closureDigest,created_at:c.timestamp,created_command_token:c.token});
  items.forEach((item,position)=>insert('analysis_study_closure_items',{id:'closure-item-'+position,project_id:f.projectId,closure_id:'closure',...snake(item),created_at:c.timestamp}));
  const head=f.db.prepare("SELECT *,CAST(version AS TEXT) version_text FROM analysis_study_events WHERE study_id='study' ORDER BY version DESC LIMIT 1").get()!;
  const requestDigest=study.analysisStudyEventRequestDigest({studyId:'study',expectedVersion:String(head.version_text),eventType:'coding_closed',reason:artifact.closeReason});
  const event={id:'close-event',projectId:f.projectId,studyId:'study',version:String(BigInt(String(head.version_text))+1n),predecessorEventId:String(head.id),predecessorEventDigest:String(head.event_digest),eventType:'coding_closed',fromState:'coding_open',toState:'coding_closed',stoppingRule:null,closeCause:artifact.closeCause,closureId:'closure',closureDigest,expectedClosureDigest:null,reason:artifact.closeReason,actorSubjectId:artifact.closeActorSubjectId,actorUserId:artifact.closeActorUserId,actorRole:artifact.closeActorRole,idempotencyKey:'close',requestDigest,occurredAt:c.timestamp};
  insert('analysis_study_events',{...snake(event),close_at:null,event_digest:study.analysisStudyEventDigest(event as never)});
  insert('analysis_study_closure_finalizations',{closure_id:'closure',project_id:f.projectId,command_token:c.token});options.after?.(c);return artifact;
 },()=>options.now??f.now+100);
}
export function completeStudy(f:Fixture,expectedClosureDigest?:string){
 return sqliteCommand(f.db,c=>{
  const head=f.db.prepare("SELECT *,CAST(version AS TEXT) version_text FROM analysis_study_events WHERE study_id='study' ORDER BY version DESC LIMIT 1").get()!;
  const expected=expectedClosureDigest??String(head.closure_digest);
  const requestDigest=study.analysisStudyEventRequestDigest({studyId:'study',expectedVersion:String(head.version_text),eventType:'study_completed',expectedClosureDigest:expected});
  const event={id:'complete-event',projectId:f.projectId,studyId:'study',version:String(BigInt(String(head.version_text))+1n),predecessorEventId:String(head.id),predecessorEventDigest:String(head.event_digest),eventType:'study_completed',fromState:'coding_closed',toState:'completed',stoppingRule:null,closeCause:null,closureId:null,closureDigest:null,expectedClosureDigest:expected,reason:null,actorSubjectId:'subject',actorUserId:f.userId,actorRole:'owner',idempotencyKey:'complete',requestDigest,occurredAt:c.timestamp};
  const row={...Object.fromEntries(Object.entries(event).map(([k,v])=>[k.replace(/[A-Z]/g,m=>'_'+m.toLowerCase()),v])),close_at:null,event_digest:study.analysisStudyEventDigest(event as never)};
  const keys=Object.keys(row);c.db.prepare(`INSERT INTO analysis_study_events(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
 },()=>f.now+102);
}
