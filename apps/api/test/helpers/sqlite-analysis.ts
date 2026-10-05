import { revision as taxonomyRevision, existing as taxonomyExisting } from './sqlite-taxonomy.js';
import { analysisAssignmentRequestDigest, analysisAssignmentEventDigest, analysisStudyItemViewContentDigest, analysisStudyItemViewRequestDigest, analysisStudyItemEventDigest, analysisStudyItemEventRequestDigest, analysisStudyEventDigest, analysisStudyEventRequestDigest, analysisStudyContentDigest, analysisStudyItemContentDigest, analysisStudyRequestDigest } from '../../src/lib/analysis-study.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SQLInputValue } from 'node:sqlite';
import { openSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime } from './sqlite.js';
import { sqliteCommand, type SqliteCommandContext } from '../../src/storage/sqlite/command-context.js';
import { sqliteCommands } from '../../src/storage/sqlite/commands.js';
import * as population from '../../src/lib/analysis-population.js';
import { datasetRevisionContentDigest, datasetRevisionDigest } from '../../src/lib/dataset-revision.js';
export const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
export type Fixture=Awaited<ReturnType<typeof fixture>>;
export type RecordValue=Record<string,SQLInputValue>;
export type Hook=(table:string,value:RecordValue,context:SqliteCommandContext)=>RecordValue|null;
export async function fixture() {
 vi.stubEnv('BETTER_AUTH_SECRET','sqlite-population-secret-at-least-32-characters');
 const dir=mkdtempSync(join(tmpdir(),'rubrist-populations-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'db.sqlite'),runtime=await createUnseededSqliteRuntime(path);cleanup.push(()=>runtime.close());
 const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
 const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
 for(let i=0;i<3;i++)await runtime.repository.importTrace(projectId,'manual',{input:{question:`Population ${i}`},output:'Answer',metadata:{}},{ingestionPurpose:'analysis_eligible_manual'});
 await runtime.repository.importTrace(projectId,'manual',{input:'excluded',output:'Answer',metadata:{}},{ingestionPurpose:'judge_api'});
 const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
 const now=Date.now()+120000;
 db.prepare('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,sqlite_subject_digest(?,?),?)').run('subject',projectId,user.id,projectId,'subject',new Date().toISOString());
 return {db,runtime,path,projectId,userId:user.id,now};
}

export function freeze(f:Fixture,hook:Hook=(_,row)=>row,after?:(context:SqliteCommandContext)=>void) {
 return sqliteCommand(f.db,context=>{
  const projectId=f.projectId,stamp=context.timestamp,populationId='ap',revisionId='rev',drawId='draw';
  const insert=(table:string,row:RecordValue)=>{const value=hook(table,row,context);if(!value)return;const keys=Object.keys(value);context.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));};
  const cases=f.db.prepare(`SELECT c.*,r.source_trace_id,i.input_digest FROM cases c JOIN raw_traces r ON r.id=c.raw_trace_id JOIN case_input_identity_records i ON i.source_case_id=c.id WHERE c.project_id=? ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id)`).all(projectId);
  const members=cases.filter(c=>String(c.ingestion_purpose).startsWith('analysis_eligible_')).map((c,position)=>{
   const payload=JSON.parse(String(c.normalized_payload)),reference=population.analysisPopulationReferenceProvenance(String(c.id));
   const snapshot={input:payload.input,output:payload.output,metadata:payload.metadata??{},...(Array.isArray(payload.steps)?{steps:payload.steps}:{})};
   const itemDigest=population.analysisPopulationItemDigest({caseId:String(c.id),inputIdentity:{basis:'input-identity/v1',digest:String(c.input_digest)},payloadSnapshot:snapshot});
   const digested={caseId:String(c.id),inputDigest:String(c.input_digest),itemDigest,ingestionTime:String(c.created_at),position};
   return {c,position,snapshot,reference,itemDigest,id:`member-${position}`,revisionItemId:`item-${position}`,frameMemberDigest:population.analysisPopulationFrameMemberDigest(digested),lineageDigest:population.analysisPopulationMemberLineageDigest({...digested,revisionItemId:`item-${position}`})};
  });
  const exclusions=cases.filter(c=>!String(c.ingestion_purpose).startsWith('analysis_eligible_'));
  const windowStart='2020-01-01T00:00:00.000Z',windowEnd=new Date(f.now-60001).toISOString(),fixedBudget=2;
  const frameDigest=population.analysisPopulationFrameDigest({projectId,windowStart,windowEnd,frameMemberDigests:members.map(m=>m.frameMemberDigest)}),itemDigests=members.map(m=>m.itemDigest);
  insert('analysis_populations',{id:populationId,project_id:projectId,dataset_revision_id:revisionId,window_start:windowStart,window_end:windowEnd,eligible_sources:'["manual","langsmith","langfuse","ironside"]',eligible_ingestion_purposes:'["analysis_eligible_manual","analysis_eligible_langsmith","analysis_eligible_langfuse","analysis_eligible_ironside"]',canonicalization_version:'governed-content-json/v1',ordering_version:'cases-created-at-id/v1',population_size:members.length,exclusion_count:exclusions.length,frame_digest:frameDigest,content_digest:population.analysisPopulationContentDigest(itemDigests),snapshot_kind:'sqlite-serialized-freeze/v1',snapshot_taken_at:stamp,created_by_user_id:f.userId,created_by_subject_id:'subject',created_at:stamp,created_command_token:context.token});
  insert('dataset_revisions',{id:revisionId,project_id:projectId,series_id:'analysis-population:'+populationId,revision_number:1,role:'analysis_authoring',source_kind:'analysis_population',identity_basis:'input-identity/v1',content_digest:datasetRevisionContentDigest(itemDigests),revision_digest:datasetRevisionDigest({role:'analysis_authoring',itemDigests}),item_count:members.length,provenance_level:'unverified',created_by_user_id:f.userId,analysis_population_id:populationId,created_at:stamp});
  for(const m of members){
   insert('dataset_revision_items',{id:m.revisionItemId,project_id:projectId,revision_id:revisionId,position:m.position,source_case_id:m.c.id!,source_trace_id:m.c.source_trace_id!,input_digest:m.c.input_digest!,item_digest:m.itemDigest,payload_snapshot:JSON.stringify(m.snapshot),reference_provenance:JSON.stringify(m.reference),created_at:stamp});
   insert('analysis_population_members',{id:m.id,project_id:projectId,population_id:populationId,revision_item_id:m.revisionItemId,case_id:m.c.id!,raw_trace_id:m.c.raw_trace_id!,source_trace_id:m.c.source_trace_id!,case_type:m.c.case_type!,ingestion_purpose:m.c.ingestion_purpose!,position:m.position,ingestion_time:m.c.created_at!,input_digest:m.c.input_digest!,item_digest:m.itemDigest,frame_member_digest:m.frameMemberDigest,lineage_digest:m.lineageDigest,created_at:stamp});
  }
  for(const [position,c] of exclusions.entries())insert('analysis_population_exclusions',{id:`excluded-${position}`,project_id:projectId,population_id:populationId,case_id:c.id!,raw_trace_id:c.raw_trace_id!,source_trace_id:c.source_trace_id!,case_type:c.case_type!,ingestion_purpose:c.ingestion_purpose!,position,ingestion_time:c.created_at!,reason:'ineligible_ingestion_purpose',content_digest:population.analysisPopulationExclusionDigest({caseId:String(c.id),rawTraceId:String(c.raw_trace_id),sourceTraceId:String(c.source_trace_id),caseType:'manual',ingestionPurpose:'judge_api',ingestionTime:String(c.created_at),position:String(position),reason:'ineligible_ingestion_purpose'}),created_at:stamp});
  const draw=population.drawAnalysisPopulationSample({populationId,datasetRevisionId:revisionId,frameDigest,seed:'a'.repeat(64),fixedBudget,members:members.map(m=>({memberId:m.id,revisionItemId:m.revisionItemId,caseId:String(m.c.id),frameMemberDigest:m.frameMemberDigest}))});
  insert('analysis_population_draws',{id:drawId,project_id:projectId,population_id:populationId,dataset_revision_id:revisionId,method:draw.method,stopping_rule:draw.stoppingRule,draw_executor:draw.drawExecutor,seed:draw.seed,rng_version:draw.rngVersion,algorithm_version:draw.algorithmVersion,fixed_budget:fixedBudget,population_size:members.length,inclusion_numerator:fixedBudget,inclusion_denominator:members.length,draw_digest:draw.drawDigest,content_digest:draw.contentDigest,executed_by_subject_id:'subject',executed_at:stamp});
  for(const s of draw.selections)insert('analysis_population_draw_items',{id:`selected-${s.position}`,project_id:projectId,population_id:populationId,draw_id:drawId,member_id:s.memberId,revision_item_id:s.revisionItemId,case_id:s.caseId,position:s.position,frame_member_digest:s.frameMemberDigest,rank_digest:s.rankDigest,content_digest:s.contentDigest,created_at:stamp});
  insert('analysis_population_requests',{id:'request',project_id:projectId,population_id:populationId,idempotency_key:'request-key',request_digest:population.analysisPopulationRequestDigest({projectId,windowStart,windowEnd,fixedBudget}),created_at:stamp});
  insert('dataset_exposure_events',{id:'creation',project_id:projectId,revision_id:revisionId,kind:'created',exposure_class:'lineage',activity:'revision_create',subject_kind:'person',subject_id:'subject',actor_user_id:f.userId,evidence_ref_kind:'analysis_population',evidence_ref_id:populationId,details:'{}',idempotency_key:'created',occurred_at:stamp});
  insert('dataset_revision_finalizations',{project_id:projectId,revision_id:revisionId});
  insert('analysis_population_finalizations',{project_id:projectId,population_id:populationId,command_token:context.token});
  after?.(context);return {populationId,revisionId,draw};
 },()=>f.now);
}

export function draftStudy(f:Fixture,hook:Hook=(_,row)=>row){
 return sqliteCommand(f.db,c=>{
  const insert=(table:string,row:RecordValue)=>{const value=hook(table,row,c);if(!value)return;const columns=Object.keys(value);c.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(value));};
  const basis={projectId:f.projectId,populationId:'ap',drawId:'draw',datasetRevisionId:'rev',contractVersion:'analysis-study/v1' as const};
  insert('analysis_studies',{id:'study',project_id:f.projectId,population_id:'ap',draw_id:'draw',dataset_revision_id:'rev',contract_version:basis.contractVersion,idempotency_key:'study-create',request_digest:analysisStudyRequestDigest(f.projectId,'ap'),content_digest:analysisStudyContentDigest(basis),created_by_user_id:f.userId,created_by_subject_id:'subject',created_at:c.timestamp,created_command_token:c.token});
  for(const d of f.db.prepare('SELECT * FROM analysis_population_draw_items ORDER BY position').all()){
   const item={studyId:'study',drawItemId:String(d.id),memberId:String(d.member_id),revisionItemId:String(d.revision_item_id),caseId:String(d.case_id),position:Number(d.position)};
   insert('analysis_study_items',{id:'study-item-'+item.position,project_id:f.projectId,study_id:'study',draw_item_id:item.drawItemId,member_id:item.memberId,revision_item_id:item.revisionItemId,case_id:item.caseId,position:item.position,content_digest:analysisStudyItemContentDigest(item),created_at:c.timestamp});
  }
  insert('analysis_study_finalizations',{study_id:'study',project_id:f.projectId,command_token:c.token});
 },()=>f.now+1);
}

export function studyEvent(f:Fixture,type:'coding_opened'|'study_abandoned'='coding_opened',options:{deadline?:string;now?:number;override?:RecordValue}={}){
 return sqliteCommand(f.db,c=>{
  const head=f.db.prepare('SELECT *,CAST(version AS TEXT) version_text FROM analysis_study_events ORDER BY version DESC LIMIT 1').get();
  const version=BigInt(String(head?.version_text??'0'))+1n;
  const stoppingRule=type==='coding_opened'?{kind:options.deadline?'server_deadline':'explicit_owner_close',closeAt:options.deadline??null}:null;
  const request={studyId:'study',expectedVersion:String(version-1n),eventType:type,...(stoppingRule?{stoppingRule}:{reason:'Owner abandons study'})};
  const requestDigest=analysisStudyEventRequestDigest(request as never);
  const event={id:'event-'+version,projectId:f.projectId,studyId:'study',version:String(version),predecessorEventId:head?.id??null,predecessorEventDigest:head?.event_digest??null,
   eventType:type,fromState:head?.to_state??'draft',toState:type==='coding_opened'?'coding_open':'abandoned',stoppingRule,closeCause:null,closureId:null,closureDigest:null,expectedClosureDigest:null,reason:stoppingRule?null:'Owner abandons study',actorSubjectId:'subject',actorUserId:f.userId,actorRole:'owner',idempotencyKey:'event-key-'+version,requestDigest,occurredAt:c.timestamp};
  const row:RecordValue={id:event.id,project_id:f.projectId,study_id:'study',version,predecessor_event_id:event.predecessorEventId,predecessor_event_digest:event.predecessorEventDigest,event_type:type,from_state:event.fromState,to_state:event.toState,stopping_rule:stoppingRule?.kind??null,close_at:stoppingRule?.closeAt??null,close_cause:null,closure_id:null,closure_digest:null,expected_closure_digest:null,reason:event.reason,actor_subject_id:'subject',actor_user_id:f.userId,actor_role:'owner',idempotency_key:event.idempotencyKey,request_digest:requestDigest,event_digest:analysisStudyEventDigest(event as never),occurred_at:c.timestamp,...options.override};
  const columns=Object.keys(row);c.db.prepare(`INSERT INTO analysis_study_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
  return row;
 },()=>options.now??f.now+2);
}

export function itemEvent(f:Fixture,type:string,options:{itemId?:string;now?:number;target?:RecordValue;anchor?:{kind:string;stepIndex?:number};override?:RecordValue;actor?:{userId:string;subjectId:string;role:'owner'|'member'}}={}){
 return sqliteCommand(f.db,c=>{
  const actor=options.actor??{userId:f.userId,subjectId:'subject',role:'owner' as const};
  const studyItemId=options.itemId??'study-item-0';
  const head=f.db.prepare('SELECT *,CAST(version AS TEXT) version_text FROM analysis_study_item_events WHERE study_item_id=? ORDER BY version DESC LIMIT 1').get(studyItemId);
  const version=BigInt(String(head?.version_text??'0'))+1n;
  const details=type==='coding_completed'?{}:type==='failure_observed'?{failureLabel:'Missing context',rationale:'The answer omits relevant context',evidenceAnchor:options.anchor??{kind:'case_output'}}:
   type==='no_failure_observed'?{rationale:'No failure observed'}:{rationale:'Reviewed correction',targetEventId:options.target?.id,targetEventDigest:options.target?.event_digest};
  const idempotencyKey=studyItemId+'-key-'+version;
  const requestDigest=analysisStudyItemEventRequestDigest(f.projectId,'study',studyItemId,{eventType:type,expectedVersion:String(version-1n),idempotencyKey,...details} as never);
  const event={id:studyItemId+'-event-'+version,projectId:f.projectId,studyId:'study',studyItemId,version:String(version),predecessorEventId:head?.id??null,predecessorEventDigest:head?.event_digest??null,eventType:type,...details,
   actorSubjectId:actor.subjectId,actorUserId:actor.userId,actorRole:actor.role,idempotencyKey,requestDigest,occurredAt:c.timestamp};
  const anchor='evidenceAnchor' in details?details.evidenceAnchor:null;
  const row:RecordValue={id:event.id,project_id:f.projectId,study_id:'study',study_item_id:studyItemId,version,predecessor_event_id:event.predecessorEventId,predecessor_event_digest:event.predecessorEventDigest,event_type:type,
   target_event_id:options.target?.id??null,target_event_digest:options.target?.event_digest??null,failure_label:details.failureLabel??null,rationale:details.rationale??null,anchor_kind:anchor?.kind??null,anchor_step_index:anchor?.stepIndex??null,
   actor_subject_id:actor.subjectId,actor_user_id:actor.userId,actor_role:actor.role,idempotency_key:idempotencyKey,request_digest:requestDigest,event_digest:analysisStudyItemEventDigest(event as never),occurred_at:c.timestamp,...options.override};
  const columns=Object.keys(row);c.db.prepare(`INSERT INTO analysis_study_item_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));return row;
 },()=>options.now??f.now+3);
}

export function itemView(f:Fixture,override:RecordValue={},now=f.now+4,actor={userId:f.userId,subjectId:'subject'}){
 return sqliteCommand(f.db,c=>{
  const exposure={id:'view-exposure',project_id:f.projectId,revision_id:'rev',revision_item_id:null,kind:'human_access',exposure_class:'development',activity:'content_view',subject_kind:'person',subject_id:actor.subjectId,actor_user_id:actor.userId,evidence_ref_kind:'analysis_population',evidence_ref_id:'ap',reason:null,details:'{}',idempotency_key:'view-exposure',occurred_at:c.timestamp};
  const columns=Object.keys(exposure);c.db.prepare(`INSERT INTO dataset_exposure_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(exposure));
  const basis={projectId:f.projectId,studyId:'study',studyItemId:'study-item-0',viewerUserId:actor.userId,viewerSubjectId:actor.subjectId,datasetRevisionId:'rev'};
  const requestDigest=analysisStudyItemViewRequestDigest(basis);
  const countsTowardClosure=f.db.prepare("SELECT to_state FROM analysis_study_events WHERE study_id='study' ORDER BY version DESC LIMIT 1").get()?.to_state==='coding_open';
  const view={...basis,id:'view',idempotencyKey:'view',datasetExposureEventId:exposure.id,countsTowardClosure,requestDigest,viewedAt:c.timestamp};
  const row:RecordValue={id:'view',project_id:f.projectId,study_id:'study',study_item_id:'study-item-0',dataset_exposure_event_id:exposure.id,viewer_user_id:actor.userId,viewer_subject_id:actor.subjectId,idempotency_key:'view',request_digest:requestDigest,content_digest:analysisStudyItemViewContentDigest(view),counts_toward_closure:Number(countsTowardClosure),viewed_at:c.timestamp,...override};
  const keys=Object.keys(row);c.db.prepare(`INSERT INTO analysis_study_item_views(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
 },()=>now);
}

export function assignment(f:Fixture,observation:RecordValue,type:'assigned'|'withdrawn'='assigned',options:{now?:number;revisionId?:string;override?:RecordValue}={}){
 return sqliteCommand(f.db,c=>{
  const head=f.db.prepare('SELECT *,CAST(version AS TEXT) version_text FROM analysis_observation_assignment_events WHERE observation_event_id=? ORDER BY version DESC LIMIT 1').get(observation.id!);
  const revision=f.db.prepare('SELECT * FROM analysis_failure_taxonomy_revisions WHERE id=coalesce(?,(SELECT id FROM analysis_failure_taxonomy_revisions ORDER BY sequence DESC LIMIT 1))').get(options.revisionId??null)!;
  const version=BigInt(String(head?.version_text??'0'))+1n;
  const request={eventType:type,observationEventId:String(observation.id),taxonomyRevisionId:String(revision.id),expectedVersion:String(version-1n),expectedPredecessorEventId:head?.id??null,expectedPredecessorEventDigest:head?.event_digest??null,codeId:type==='assigned'?'revision-1-first':null,rationale:'Human categorization',idempotencyKey:'assignment-'+version};
  const requestDigest=analysisAssignmentRequestDigest(request as never);
  const event={id:'assignment-'+version,projectId:f.projectId,studyId:'study',studyItemId:String(observation.study_item_id),observationEventId:request.observationEventId,version:String(version),predecessorEventId:request.expectedPredecessorEventId,predecessorEventDigest:request.expectedPredecessorEventDigest,eventType:type,taxonomyId:'taxonomy',taxonomyRevisionId:request.taxonomyRevisionId,taxonomyRevisionSequence:Number(revision.sequence),codeId:request.codeId,rationale:request.rationale,actorSubjectId:'subject',actorUserId:f.userId,actorRole:'owner',idempotencyKey:request.idempotencyKey,requestDigest,occurredAt:c.timestamp};
  const row:RecordValue={id:event.id,project_id:f.projectId,study_id:'study',study_item_id:event.studyItemId,observation_event_id:event.observationEventId,version,predecessor_event_id:event.predecessorEventId,predecessor_event_digest:event.predecessorEventDigest,event_type:type,taxonomy_id:'taxonomy',taxonomy_revision_id:event.taxonomyRevisionId,taxonomy_revision_sequence:event.taxonomyRevisionSequence,code_id:event.codeId,rationale:event.rationale,actor_subject_id:'subject',actor_user_id:f.userId,actor_role:'owner',idempotency_key:event.idempotencyKey,request_digest:requestDigest,event_digest:analysisAssignmentEventDigest(event as never),occurred_at:c.timestamp,...options.override};
  const columns=Object.keys(row);c.db.prepare(`INSERT INTO analysis_observation_assignment_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));return row;
 },()=>options.now??f.now+5);
}
