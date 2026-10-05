import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AnalysisPopulationCreateInputSchema, DatasetRevisionPayloadSnapshotSchema, type AnalysisPopulationCreateInput } from '@rubrist/shared';
import { AnalysisPopulationRepositoryError, type AnalysisPopulationActor } from '../../analysis-population/repository.js';
import * as evidence from '../../lib/analysis-population.js';
import { datasetRevisionContentDigest, datasetRevisionDigest } from '../../lib/dataset-revision.js';
import type { SqliteCommandContext } from './command-context.js';
import { governedJsonTextDigest } from './governed-json-text.js';

export function requirePopulationAccess(db:DatabaseSync,actor:AnalysisPopulationActor,owner=false) {
 const role=db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(actor.projectId,actor.userId)?.role;
 if(!role||owner&&(role!=='owner'||actor.projectRole!=='owner'))throw new AnalysisPopulationRepositoryError('analysis_population_forbidden','Analysis population access is forbidden');
}
export function populationSubject(db:DatabaseSync,actor:AnalysisPopulationActor,stamp:string):string {
 const id=`grs_${createHash('sha256').update(actor.projectId+'\0'+actor.userId).digest('hex').slice(0,32)}`;
 db.prepare('INSERT INTO governed_reviewer_subjects(id,project_id,account_user_id,subject_digest,created_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,account_user_id) DO NOTHING')
 .run(id,actor.projectId,actor.userId,governedJsonTextDigest('governed-reviewer-subject/v1',JSON.stringify({projectId:actor.projectId,subjectId:id})),stamp);
 return String(db.prepare('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?').get(actor.projectId,actor.userId)!.id);
}
const eligible="('analysis_eligible_manual','analysis_eligible_langsmith','analysis_eligible_langfuse','analysis_eligible_ironside')";
const excluded="('judge_api','judge_batch_general','dataset_example','trace_test_synthetic','release_evidence')";
const uid=(prefix:string)=>`${prefix}_${randomUUID()}`;
const err=(code:ConstructorParameters<typeof AnalysisPopulationRepositoryError>[0],message:string)=>new AnalysisPopulationRepositoryError(code,message);
function snapshot(value:unknown){try{const row=JSON.parse(String(value));if(!row||!('input' in row)||!('output' in row))throw new Error('Incomplete retained payload');return DatasetRevisionPayloadSnapshotSchema.parse({input:row.input,output:row.output,metadata:row.metadata??{},...(Array.isArray(row.steps)?{steps:row.steps}:{})});}catch{throw err('analysis_population_revision_conflict','Eligible evidence has no valid retained payload');}}
/** The only retained array contains compact identities/digests; payloads are read one at a time. */
export function buildSqlitePopulation(db:DatabaseSync,context:SqliteCommandContext,actor:AnalysisPopulationActor,rawInput:AnalysisPopulationCreateInput) {
 const input=AnalysisPopulationCreateInputSchema.parse(rawInput),projectId=actor.projectId,stamp=context.timestamp;
 requirePopulationAccess(db,actor,true);
 const subjectId=populationSubject(db,actor,stamp),requestDigest=evidence.analysisPopulationRequestDigest({projectId,...input});
 const replay=db.prepare('SELECT request_digest,population_id FROM analysis_population_requests WHERE project_id=? AND idempotency_key=?').get(projectId,input.idempotencyKey);
 if(replay){if(replay.request_digest!==requestDigest)throw err('analysis_population_idempotency_conflict','Analysis population idempotency key was reused with different input');return {populationId:String(replay.population_id),reused:true};}
 try{evidence.assertAnalysisPopulationWindow(input,stamp);}catch(error){throw err('analysis_population_window_too_recent',error instanceof Error?error.message:'Invalid window');}
 const windowStart=evidence.normalizeAnalysisPopulationTimestamp(input.windowStart),windowEnd=evidence.normalizeAnalysisPopulationTimestamp(input.windowEnd);
 const counts=db.prepare(`SELECT sum(ingestion_purpose IN ${eligible}) eligible,sum(ingestion_purpose IN ${excluded}) excluded FROM cases WHERE project_id=? AND created_at>=? AND created_at<?`).get(projectId,windowStart,windowEnd)!;
 const populationSize=Number(counts.eligible??0),exclusionCount=Number(counts.excluded??0);
 try{evidence.assertAnalysisPopulationDrawBounds(populationSize,input.fixedBudget);}catch(error){
  if(error instanceof evidence.AnalysisPopulationBoundError)throw new AnalysisPopulationRepositoryError(error.code,error.message,{limit:error.limit,observed:error.observed,fixedBudget:input.fixedBudget});throw error;
 }
 const scan=db.prepare(`SELECT c.id,c.created_at,c.case_type,c.ingestion_purpose,c.raw_trace_id,r.source_trace_id,
 (SELECT count(DISTINCT input_digest) FROM case_input_identity_records i WHERE i.project_id=c.project_id AND i.source_case_id=c.id AND i.identity_basis='input-identity/v1' AND i.record_kind IN ('authoring_import','identity_resolved')) identity_count,
 (SELECT min(input_digest) FROM case_input_identity_records i WHERE i.project_id=c.project_id AND i.source_case_id=c.id AND i.identity_basis='input-identity/v1' AND i.record_kind IN ('authoring_import','identity_resolved')) input_digest
 FROM cases c LEFT JOIN raw_traces r ON r.project_id=c.project_id AND r.id=c.raw_trace_id
 WHERE c.project_id=? AND c.created_at>=? AND c.created_at<? AND c.ingestion_purpose IN ${eligible} ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id)`);
 const payload=db.prepare('SELECT normalized_payload FROM cases WHERE project_id=? AND id=?');
 const claim=db.prepare('SELECT usage_class FROM governed_input_identity_claims WHERE project_id=? AND input_digest=?');
 const members=[];
 for(const c of scan.iterate(projectId,windowStart,windowEnd)){
  if(!c.raw_trace_id||!c.source_trace_id||!c.input_digest||Number(c.identity_count)!==1)throw err('analysis_population_identity_unresolved','Eligible evidence lacks exact retained identity');
  if(claim.get(projectId,c.input_digest)?.usage_class==='sealed')throw err('analysis_population_sealed_overlap','Analysis population overlaps protected sealed evidence');
  const caseId=String(c.id),inputDigest=String(c.input_digest),position:number=members.length,revisionItemId=uid('dsri');
  let itemDigest:string;
  try{itemDigest=evidence.analysisPopulationItemDigest({caseId,inputIdentity:{basis:'input-identity/v1',digest:inputDigest},payloadSnapshot:snapshot(payload.get(projectId,caseId)!.normalized_payload)});}
  catch{throw err('analysis_population_revision_conflict','Eligible evidence has no valid retained payload');}
  const base={caseId,inputDigest,itemDigest,position,ingestionTime:String(c.created_at)};
  members.push({...base,id:uid('apm'),revisionItemId,rawTraceId:String(c.raw_trace_id),sourceTraceId:String(c.source_trace_id),caseType:String(c.case_type),ingestionPurpose:String(c.ingestion_purpose),frameMemberDigest:evidence.analysisPopulationFrameMemberDigest(base),lineageDigest:evidence.analysisPopulationMemberLineageDigest({...base,revisionItemId})});
 }
 const frameDigest=evidence.analysisPopulationFrameDigest({projectId,windowStart,windowEnd,frameMemberDigests:members.map(m=>m.frameMemberDigest)});
 const existing=db.prepare('SELECT p.id,d.fixed_budget FROM analysis_populations p JOIN analysis_population_draws d ON d.population_id=p.id WHERE p.project_id=? AND p.frame_digest=?').get(projectId,frameDigest);
 const insert=(table:string,row:Record<string,SQLInputValue>)=>{const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
 const request=(populationId:string)=>insert('analysis_population_requests',{id:uid('apr'),project_id:projectId,population_id:populationId,idempotency_key:input.idempotencyKey,request_digest:requestDigest,created_at:stamp});
 if(existing){
  if(Number(existing.fixed_budget)!==input.fixedBudget)throw new AnalysisPopulationRepositoryError('analysis_population_draw_conflict','An identical frame already has a different fixed draw budget',{existingFixedBudget:Number(existing.fixed_budget),requestedFixedBudget:input.fixedBudget});
  request(String(existing.id));return {populationId:String(existing.id),reused:true};
 }
 const populationId=uid('ap'),revisionId=uid('dsr'),drawId=uid('apd'),itemDigests=members.map(m=>m.itemDigest);
 insert('analysis_populations',{id:populationId,project_id:projectId,dataset_revision_id:revisionId,window_start:windowStart,window_end:windowEnd,eligible_sources:'["manual","langsmith","langfuse","ironside"]',eligible_ingestion_purposes:'["analysis_eligible_manual","analysis_eligible_langsmith","analysis_eligible_langfuse","analysis_eligible_ironside"]',canonicalization_version:'governed-content-json/v1',ordering_version:'cases-created-at-id/v1',population_size:populationSize,exclusion_count:exclusionCount,frame_digest:frameDigest,content_digest:evidence.analysisPopulationContentDigest(itemDigests),snapshot_kind:'sqlite-serialized-freeze/v1',snapshot_taken_at:stamp,created_by_user_id:actor.userId,created_by_subject_id:subjectId,created_at:stamp,created_command_token:context.token});
 insert('dataset_revisions',{id:revisionId,project_id:projectId,series_id:'analysis-population:'+populationId,revision_number:1,role:'analysis_authoring',source_kind:'analysis_population',identity_basis:'input-identity/v1',content_digest:datasetRevisionContentDigest(itemDigests),revision_digest:datasetRevisionDigest({role:'analysis_authoring',itemDigests}),item_count:populationSize,provenance_level:'unverified',created_by_user_id:actor.userId,analysis_population_id:populationId,created_at:stamp});
 for(const m of members){
  insert('dataset_revision_items',{id:m.revisionItemId,project_id:projectId,revision_id:revisionId,position:m.position,source_case_id:m.caseId,source_trace_id:m.sourceTraceId,input_digest:m.inputDigest,item_digest:m.itemDigest,payload_snapshot:JSON.stringify(snapshot(payload.get(projectId,m.caseId)!.normalized_payload)),reference_provenance:JSON.stringify(evidence.analysisPopulationReferenceProvenance(m.caseId)),created_at:stamp});
  insert('analysis_population_members',{id:m.id,project_id:projectId,population_id:populationId,revision_item_id:m.revisionItemId,case_id:m.caseId,raw_trace_id:m.rawTraceId,source_trace_id:m.sourceTraceId,case_type:m.caseType,ingestion_purpose:m.ingestionPurpose,position:m.position,ingestion_time:m.ingestionTime,input_digest:m.inputDigest,item_digest:m.itemDigest,frame_member_digest:m.frameMemberDigest,lineage_digest:m.lineageDigest,created_at:stamp});
 }
 let position=0;
 for(const c of db.prepare(`SELECT c.id,c.case_type,c.ingestion_purpose,c.created_at,c.raw_trace_id,r.source_trace_id FROM cases c LEFT JOIN raw_traces r ON r.project_id=c.project_id AND r.id=c.raw_trace_id WHERE c.project_id=? AND c.created_at>=? AND c.created_at<? AND c.ingestion_purpose IN ${excluded} ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id)`).iterate(projectId,windowStart,windowEnd)){
  const value={caseId:String(c.id),rawTraceId:c.raw_trace_id===null?null:String(c.raw_trace_id),sourceTraceId:c.source_trace_id===null?null:String(c.source_trace_id),caseType:String(c.case_type),ingestionPurpose:String(c.ingestion_purpose),ingestionTime:String(c.created_at),position:String(position),reason:'ineligible_ingestion_purpose'} as evidence.AnalysisPopulationExclusionDigestInput;
  insert('analysis_population_exclusions',{id:uid('ape'),project_id:projectId,population_id:populationId,case_id:value.caseId,raw_trace_id:value.rawTraceId,source_trace_id:value.sourceTraceId,case_type:value.caseType,ingestion_purpose:value.ingestionPurpose,position,ingestion_time:value.ingestionTime,reason:value.reason,content_digest:evidence.analysisPopulationExclusionDigest(value),created_at:stamp});position++;
 }
 const draw=evidence.drawAnalysisPopulationSample({populationId,datasetRevisionId:revisionId,frameDigest,seed:randomBytes(32).toString('hex'),fixedBudget:input.fixedBudget,members:members.map(m=>({memberId:m.id,revisionItemId:m.revisionItemId,caseId:m.caseId,frameMemberDigest:m.frameMemberDigest}))});
 insert('analysis_population_draws',{id:drawId,project_id:projectId,population_id:populationId,dataset_revision_id:revisionId,method:draw.method,stopping_rule:draw.stoppingRule,draw_executor:draw.drawExecutor,seed:draw.seed,rng_version:draw.rngVersion,algorithm_version:draw.algorithmVersion,fixed_budget:draw.fixedBudget,population_size:populationSize,inclusion_numerator:draw.inclusionProbability.numerator,inclusion_denominator:draw.inclusionProbability.denominator,draw_digest:draw.drawDigest,content_digest:draw.contentDigest,executed_by_subject_id:subjectId,executed_at:stamp});
 for(const s of draw.selections)insert('analysis_population_draw_items',{id:uid('apdi'),project_id:projectId,population_id:populationId,draw_id:drawId,member_id:s.memberId,revision_item_id:s.revisionItemId,case_id:s.caseId,position:s.position,frame_member_digest:s.frameMemberDigest,rank_digest:s.rankDigest,content_digest:s.contentDigest,created_at:stamp});
 request(populationId);
 insert('dataset_exposure_events',{id:uid('dse'),project_id:projectId,revision_id:revisionId,kind:'created',exposure_class:'lineage',activity:'revision_create',subject_kind:'person',subject_id:subjectId,actor_user_id:actor.userId,evidence_ref_kind:'dataset_revision',evidence_ref_id:revisionId,reason:'Immutable analysis population created',details:JSON.stringify({contract:'rubrist/analysis-population-lineage/v1',populationId}),idempotency_key:`analysis-population-created:${populationId}`,occurred_at:stamp});
 insert('dataset_revision_finalizations',{project_id:projectId,revision_id:revisionId});
 insert('analysis_population_finalizations',{project_id:projectId,population_id:populationId,command_token:context.token});
 return {populationId,reused:false};
}
