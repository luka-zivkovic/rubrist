import { revision as taxonomyRevision, existing as taxonomyExisting } from './helpers/sqlite-taxonomy.js';
import { analysisAssignmentRequestDigest, analysisAssignmentEventDigest, analysisStudyItemViewContentDigest, analysisStudyItemViewRequestDigest, analysisStudyItemEventDigest, analysisStudyItemEventRequestDigest, analysisStudyEventDigest, analysisStudyEventRequestDigest, analysisStudyContentDigest, analysisStudyItemContentDigest, analysisStudyRequestDigest } from '../src/lib/analysis-study.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SQLInputValue } from 'node:sqlite';
import { openSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommand, type SqliteCommandContext } from '../src/storage/sqlite/command-context.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import * as population from '../src/lib/analysis-population.js';
import { datasetRevisionContentDigest, datasetRevisionDigest } from '../src/lib/dataset-revision.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture() {
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
type Fixture=Awaited<ReturnType<typeof fixture>>;
type RecordValue=Record<string,SQLInputValue>;
type Hook=(table:string,value:RecordValue,context:SqliteCommandContext)=>RecordValue|null;
function freeze(f:Fixture,hook:Hook=(_,row)=>row,after?:(context:SqliteCommandContext)=>void) {
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
it('persists an exact population, exclusions and reproducible draw across restart and traffic retention',async()=>{
 const f=await fixture(),created=freeze(f);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_population_members').get()?.n).toBe(3);
 expect(f.db.prepare('SELECT member_id,rank_digest FROM analysis_population_draw_items ORDER BY position').all()).toEqual(created.draw.selections.map(s=>({member_id:s.memberId,rank_digest:s.rankDigest})));
 const reopened=openSqlite(f.path);cleanup.push(()=>reopened.close());
 expect(reopened.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
 expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM cases WHERE project_id=?').run(f.projectId),()=>f.now+1);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_population_members').get()?.n).toBe(3);
 const fresh=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>fresh.close());
 await fresh.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT count(*) n FROM analysis_populations').get()?.n).toBe(0);
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each([
 ['snapshot token','analysis_populations','created_command_token','foreign'],
 ['snapshot time','analysis_populations','snapshot_taken_at','2020-01-01T00:00:00.000Z'],
 ['reciprocal revision','dataset_revisions','series_id','different'],
 ['frame digest','analysis_populations','frame_digest','sha256:'+'b'.repeat(64)],
 ['source trace','analysis_population_members','source_trace_id','foreign'],
 ['member lineage','analysis_population_members','lineage_digest','sha256:'+'b'.repeat(64)],
 ['reference provenance','dataset_revision_items','reference_label','pass'],
 ['exclusion digest','analysis_population_exclusions','content_digest','sha256:'+'b'.repeat(64)],
 ['draw rank','analysis_population_draw_items','rank_digest','sha256:'+'b'.repeat(64)],
 ['draw aggregate','analysis_population_draws','draw_digest','sha256:'+'b'.repeat(64)],
 ['request body','analysis_population_requests','request_digest','sha256:'+'b'.repeat(64)]
])('rejects forged %s through direct SQL and rolls back all evidence',async(_,table,column,value)=>{
 const f=await fixture();expect(()=>freeze(f,(name,row)=>name===table?{...row,[column]:value}:row)).toThrow();
 expect(f.db.prepare('SELECT count(*) n FROM analysis_populations').get()?.n).toBe(0);
 expect(f.db.prepare('SELECT count(*) n FROM dataset_revisions').get()?.n).toBe(0);
});
it.each(['analysis_population_finalizations','dataset_revision_finalizations','analysis_population_members','analysis_population_exclusions','analysis_population_draw_items','analysis_population_requests'])('rejects incomplete %s bundles at finalization or COMMIT',async(table)=>{
 const f=await fixture();expect(()=>freeze(f,(name,row)=>name===table?null:row)).toThrow();
 expect(f.db.prepare('SELECT count(*) n FROM analysis_populations').get()?.n).toBe(0);
});
it('rejects late same-command source removal and preserves committed source retention',async()=>{
 const f=await fixture();expect(()=>freeze(f,undefined,c=>c.db.prepare('DELETE FROM cases WHERE project_id=?').run(f.projectId))).toThrow(/source cannot change/);
 expect(f.db.prepare('SELECT count(*) n FROM cases').get()?.n).toBe(4);
 freeze(f);
 for(const table of ['analysis_populations','analysis_population_members','analysis_population_exclusions','analysis_population_draws','analysis_population_draw_items','analysis_population_requests','analysis_population_finalizations']){
  expect(()=>f.db.exec(`DELETE FROM ${table}`)).toThrow(/project erasure/);
 }
 expect(()=>f.db.exec("UPDATE analysis_population_members SET position=position")).toThrow(/immutable/);
});
it.each(['cases','raw_traces','case_input_identity_records'])('rejects source mutation of %s before finalization',async(table)=>{
 const f=await fixture();expect(()=>freeze(f,(name,row,c)=>{
  if(name==='dataset_revisions'){
   if(table==='case_input_identity_records')c.db.exec(`INSERT INTO case_input_identity_records SELECT 'copy',project_id,source_case_id,record_kind,identity_basis,input_digest,created_at FROM case_input_identity_records LIMIT 1`);
   else c.db.exec(`DELETE FROM ${table} WHERE id=(SELECT ${table==='cases'?'id':'raw_trace_id'} FROM cases WHERE ingestion_purpose='judge_api' LIMIT 1)`);
  }
  return row;
 })).toThrow(/cannot change/);
 expect(f.db.prepare('SELECT count(*) n FROM cases').get()?.n).toBe(4);
});
it.each(['2020-01-01T00:00:00.000+00:00','future'])('rejects noncanonical or recent window %s',async(value)=>{
 const f=await fixture();expect(()=>freeze(f,(name,row)=>name==='analysis_populations'?{...row,window_end:value==='future'?new Date(f.now-59999).toISOString():value}:row)).toThrow(/window|CHECK/);
});
it.each(['analysis_populations','analysis_population_members','analysis_population_draw_items'])('rejects cross-project %s bindings',async(table)=>{
 const f=await fixture();const foreign=await f.runtime.accounts.createProjectForUser({userId:f.userId,email:'owner@example.test',name:'Other'});
 expect(()=>freeze(f,(name,row)=>name===table?{...row,project_id:foreign.projectId}:row)).toThrow();
});
it('accepts an exact post-commit request alias and rejects a changed body and plain-connection writes',async()=>{
 const f=await fixture();freeze(f);
 const replay=(digest:string)=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO analysis_population_requests VALUES(?,?,?,?,?,?)').run('alias',f.projectId,'alias-key',digest,'ap',c.timestamp),()=>f.now+1);
 const digest=String(f.db.prepare('SELECT request_digest FROM analysis_population_requests').get()!.request_digest);
 expect(()=>replay('sha256:'+'b'.repeat(64))).toThrow(/request body/);replay(digest);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_population_requests').get()?.n).toBe(2);
 const plain=openSqlite(f.path);cleanup.push(()=>plain.close());
 expect(()=>plain.prepare('INSERT INTO analysis_population_requests VALUES(?,?,?,?,?,?)').run('plain',f.projectId,'plain-key',digest,'ap',new Date().toISOString())).toThrow(/function/);
});

it('rejects a rounded snapshot of a distinct exact source number',async()=>{
 const f=await fixture();
 sqliteCommand(f.db,c=>c.db.exec(`UPDATE cases SET normalized_payload='{"input":{"question":9007199254740993},"output":"Answer","metadata":{}}' WHERE ingestion_purpose='analysis_eligible_manual'`));
 expect(()=>freeze(f)).toThrow(/source snapshot mismatch|member revision binding/);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_populations').get()?.n).toBe(0);
});

it('rejects exact numeric source changes after a population is committed',async()=>{
 const f=await fixture();
 sqliteCommand(f.db,c=>c.db.exec(`UPDATE cases SET normalized_payload='{"input":9007199254740992,"output":"Answer","metadata":{}}' WHERE ingestion_purpose='analysis_eligible_manual'`));
 freeze(f);
 expect(()=>sqliteCommand(f.db,c=>c.db.exec(`UPDATE cases SET normalized_payload='{"input":9007199254740993,"output":"Answer","metadata":{}}' WHERE ingestion_purpose='analysis_eligible_manual'`),()=>f.now+1)).toThrow(/immutable/);
});
it('serializes population creation, reuses exact frames and exposes only selected retained content through the repository',async()=>{
 const f=await fixture();sqliteCommand(f.db,()=>{},()=>f.now);
 const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const input={windowStart:'2020-01-01T00:00:00.000Z',windowEnd:new Date(f.now-60001).toISOString(),fixedBudget:2,idempotencyKey:'repo-create'};
 const peer=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>peer.close());
 const [a,b]=await Promise.all([f.runtime.analysisPopulations.createPopulation(actor,input),peer.analysisPopulations.createPopulation(actor,input)]);
 expect(a.population.id).toBe(b.population.id);expect([a.reusedPopulation,b.reusedPopulation].sort()).toEqual([false,true]);
 expect(a.population).toHaveProperty('snapshotProvenance','sqlite-serialized-freeze/v1');expect(a.population).not.toHaveProperty('snapshotXid8');
 const replay=await peer.analysisPopulations.createPopulation(actor,{...input,idempotencyKey:'alias'});expect(replay.reusedPopulation).toBe(true);expect(replay.draw).toEqual(a.draw);
 await expect(peer.analysisPopulations.createPopulation(actor,{...input,fixedBudget:1})).rejects.toMatchObject({code:'analysis_population_idempotency_conflict'});
 await expect(peer.analysisPopulations.createPopulation(actor,{...input,idempotencyKey:'different-budget',fixedBudget:1})).rejects.toMatchObject({code:'analysis_population_draw_conflict'});
 const listed=await peer.analysisPopulations.listPopulations(actor,{limit:1,cursor:null});expect(listed.totalCount).toBe('1');
 const first=await peer.analysisPopulations.listMembers(actor,a.population.id,{limit:2,cursor:null});expect(first!.items).toHaveLength(2);expect(first!.nextCursor).not.toBeNull();
 const second=await peer.analysisPopulations.listMembers(actor,a.population.id,{limit:2,cursor:first!.nextCursor});expect(second!.items).toHaveLength(1);expect(second!.nextCursor).toBeNull();
 expect([...first!.items,...second!.items].map(m=>m.position)).toEqual([0,1,2]);
 expect((await peer.analysisPopulations.listExclusions(actor,a.population.id,{limit:10,cursor:null}))!.totalCount).toBe('1');
 expect((await peer.analysisPopulations.listSelections(actor,a.population.id,{limit:10,cursor:null}))!.items).toHaveLength(2);
 const content=await peer.analysisPopulations.getSelectedContent(actor,a.population.id,0);expect(content!.payloadSnapshot.output).toBe('Answer');
 expect(await peer.analysisPopulations.getSelectedContent(actor,a.population.id,2)).toBeNull();
 expect(await peer.analysisPopulations.getSelectedContent(actor,a.population.id,0)).toEqual(content);
 expect(f.db.prepare("SELECT count(*) n FROM dataset_exposure_events WHERE activity='content_view'").get()?.n).toBe(1);
 const overlap=await peer.analysisPopulations.createPopulation(actor,{...input,windowStart:'2021-01-01T00:00:00.000Z',idempotencyKey:'overlap'});
 expect((await peer.analysisPopulations.getPopulation(actor,a.population.id))!.overlapCount).toBe('1');
 expect((await peer.analysisPopulations.listOverlaps(actor,a.population.id,{limit:10,cursor:null}))!.items[0]).toMatchObject({populationId:overlap.population.id,overlapCount:3});
 await expect(peer.analysisPopulations.listMembers(actor,a.population.id,{limit:1,cursor:'invalid'})).rejects.toMatchObject({code:'analysis_population_invalid_cursor'});
 await expect(peer.analysisPopulations.getPopulation({...actor,userId:'other-user'},a.population.id)).rejects.toMatchObject({code:'analysis_population_forbidden'});
 await expect(peer.analysisPopulations.createPopulation({...actor,projectRole:'member'},input)).rejects.toMatchObject({code:'analysis_population_forbidden'});
 sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM cases WHERE project_id=?').run(f.projectId),()=>f.now+1);
 expect(await peer.analysisPopulations.getSelectedContent(actor,a.population.id,0)).toEqual(content);
});
it('serves authenticated population HTTP routes and maps invalid retained payloads to a conflict',async()=>{
 const f=await fixture();sqliteCommand(f.db,()=>{},()=>f.now);
 const {createApp}=await import('../src/app.js');
 const app=createApp(f.runtime.repository,{auth:f.runtime.auth,accounts:f.runtime.accounts,runtimeMode:'persistent',analysisPopulationRepository:f.runtime.analysisPopulations});
 const login=await app.request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'synthetic-long-password'})});expect(login.status).toBe(200);
 const headers={cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'content-type':'application/json'};
 const input={windowStart:'2020-01-01T00:00:00.000Z',windowEnd:new Date(f.now-60001).toISOString(),fixedBudget:2,idempotencyKey:'http'};
 expect((await app.request('/api/analysis-populations',{method:'POST',body:JSON.stringify(input),headers:{'content-type':'application/json'}})).status).toBe(401);
 const response=await app.request('/api/analysis-populations',{method:'POST',body:JSON.stringify(input),headers});expect(response.status).toBe(201);
 const {result}=await response.json() as {result:{population:{id:string;snapshotProvenance:string}}};expect(result.population.snapshotProvenance).toBe('sqlite-serialized-freeze/v1');
 for(const suffix of ['', '/members','/selections','/exclusions','/overlaps','/selections/0/content'])expect((await app.request('/api/analysis-populations/'+result.population.id+suffix,{headers})).status).toBe(200);
 const bad=await app.request('/api/analysis-populations',{method:'POST',body:JSON.stringify({...input,fixedBudget:1}),headers});expect(bad.status).toBe(409);expect(await bad.json()).toMatchObject({code:'analysis_population_idempotency_conflict'});
 // A later unbound source can be valid JSON but invalid frozen payload evidence.
 const malformed=await f.runtime.repository.importTrace(f.projectId,'manual',{input:'bad',output:'x',metadata:{}},{ingestionPurpose:'analysis_eligible_manual'});
 sqliteCommand(f.db,c=>c.db.prepare("UPDATE cases SET normalized_payload=json_set(normalized_payload,'$.metadata',json('[]')) WHERE id=?").run(malformed.caseId),()=>f.now+120000);
 const invalid=await app.request('/api/analysis-populations',{method:'POST',body:JSON.stringify({...input,windowEnd:new Date(f.now+60000).toISOString(),idempotencyKey:'malformed'}),headers});expect(invalid.status).toBe(409);expect(await invalid.json()).toMatchObject({code:'analysis_population_revision_conflict'});
 expect(f.db.prepare('SELECT count(*) n FROM analysis_populations').get()?.n).toBe(1);
});

it('independently re-derives retained population frames through a streaming trigger validator',async()=>{
 const f=await fixture();freeze(f);
 f.db.exec(`CREATE TABLE study_frame_checks(id INTEGER PRIMARY KEY,population_id TEXT,expected_digest TEXT);
 CREATE TRIGGER analysis_study_closure_insert BEFORE INSERT ON study_frame_checks BEGIN SELECT CASE WHEN analysis_population_frame_valid_v1(NEW.population_id,NEW.expected_digest) IS NOT 1 THEN RAISE(ABORT,'frame assessment mismatch') END; END;`);
 const digest=String(f.db.prepare('SELECT frame_digest FROM analysis_populations').get()!.frame_digest);
 const check=(id:number,expected:string|null)=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO study_frame_checks VALUES(?,?,?)').run(id,'ap',expected),()=>f.now+1);
 check(1,digest);expect(()=>check(2,'sha256:'+'b'.repeat(64))).toThrow(/frame assessment/);
 sqliteCommand(f.db,c=>c.db.exec("DELETE FROM cases WHERE id=(SELECT case_id FROM analysis_population_members WHERE position=0)"),()=>f.now+1);
 expect(()=>check(3,digest)).toThrow(/frame assessment/);check(4,null);
 expect(f.db.prepare('SELECT count(*) n FROM study_frame_checks').get()?.n).toBe(2);
});

function draftStudy(f:Fixture,hook:Hook=(_,row)=>row){
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
it('freezes one permanent study per draw with exact selected items and project-only erasure',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_study_items').get()?.n).toBe(2);
 for(const table of ['analysis_studies','analysis_study_items','analysis_study_finalizations'])expect(()=>f.db.exec(`DELETE FROM ${table}`)).toThrow(/project erasure/);
 expect(()=>f.db.exec("UPDATE analysis_study_items SET case_id='forged'")).toThrow(/immutable/);
 expect(()=>sqliteCommand(f.db,c=>c.db.exec("INSERT INTO analysis_study_items SELECT 'late',project_id,study_id,draw_item_id,member_id,revision_item_id,case_id,position,content_digest,created_at FROM analysis_study_items LIMIT 1"),()=>f.now+2)).toThrow(/creating command/);
 expect(()=>draftStudy(f,(table,row)=>table==='analysis_studies'?{...row,id:'second-study',idempotency_key:'second'}:row)).toThrow(/UNIQUE/);
 const fresh=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>fresh.close());await fresh.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT count(*) n FROM analysis_studies').get()?.n).toBe(0);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each([
 ['analysis_studies','created_by_user_id','other-user'],
 ['analysis_studies','content_digest','sha256:'+'b'.repeat(64)],
 ['analysis_studies','draw_id','missing-draw'],
 ['analysis_study_items','revision_item_id','other-item'],
 ['analysis_study_items','content_digest','sha256:'+'b'.repeat(64)],
 ['analysis_study_finalizations','command_token','foreign-command']
])('rejects forged draft study %s %s',async(table,column,value)=>{
 const f=await fixture();freeze(f);expect(()=>draftStudy(f,(name,row)=>name===table?{...row,[column]:value}:row)).toThrow();
 expect(f.db.prepare('SELECT count(*) n FROM analysis_studies').get()?.n).toBe(0);
});
it.each(['analysis_study_items','analysis_study_finalizations'])('rejects missing draft study bundle %s',async(table)=>{
 const f=await fixture();freeze(f);expect(()=>draftStudy(f,(name,row)=>name===table?null:row)).toThrow();
 expect(f.db.prepare('SELECT count(*) n FROM analysis_studies').get()?.n).toBe(0);
});

function studyEvent(f:Fixture,type:'coding_opened'|'study_abandoned'='coding_opened',options:{deadline?:string;now?:number;override?:RecordValue}={}){
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
it('appends exact open/abandon heads and retains immutable study history',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);studyEvent(f,'study_abandoned');
 expect(f.db.prepare('SELECT event_type FROM analysis_study_events ORDER BY version').all().map(r=>r.event_type)).toEqual(['coding_opened','study_abandoned']);
 expect(()=>studyEvent(f)).toThrow(/study open/);
 expect(()=>f.db.exec('DELETE FROM analysis_study_events')).toThrow(/project erasure/);
 expect(()=>f.db.exec("UPDATE analysis_study_events SET reason='rewrite'")).toThrow(/immutable/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_study_events').all()).toEqual([]);
});
it.each([
 ['predecessor_event_id','forged'],['version',3],['from_state','coding_open'],['actor_user_id','other'],['actor_role','system'],
 ['request_digest','sha256:'+'f'.repeat(64)],['event_digest','sha256:'+'f'.repeat(64)],['occurred_at','2020-01-01T00:00:00.000Z'],['idempotency_key','\t'],['to_state','completed']
])('rejects forged study transition %s',async(column,value)=>{
 const f=await fixture();freeze(f);draftStudy(f);expect(()=>studyEvent(f,'coding_opened',{override:{[column]:value}})).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_study_events').all()).toEqual([]);
});
it('enforces the frozen deadline at exact command time and permits draft abandonment',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);
 expect(()=>studyEvent(f,'coding_opened',{deadline:new Date(f.now+2).toISOString()})).toThrow(/deadline/);
 expect(()=>studyEvent(f,'coding_opened',{deadline:new Date(f.now+2000).toISOString().replace('Z','1Z')})).toThrow(/deadline/);
 studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 expect(()=>studyEvent(f,'study_abandoned',{now:f.now+1000})).toThrow(/before deadline/);
 expect(()=>studyEvent(f,'study_abandoned',{now:f.now+2000})).toThrow(/before deadline/);
 studyEvent(f,'study_abandoned',{now:f.now+999});
 const other=await fixture();freeze(other);draftStudy(other);studyEvent(other,'study_abandoned');
 expect(other.db.prepare('SELECT to_state FROM analysis_study_events').get()?.to_state).toBe('abandoned');
});

function itemEvent(f:Fixture,type:string,options:{itemId?:string;now?:number;target?:RecordValue;anchor?:{kind:string;stepIndex?:number};override?:RecordValue;actor?:{userId:string;subjectId:string;role:'owner'|'member'}}={}){
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
it('preserves multilabel observations, explicit no-failure evidence and reopen/withdraw history',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);
 expect(()=>itemEvent(f,'no_failure_observed')).toThrow(/closed by state/);
 studyEvent(f);
 expect(()=>itemEvent(f,'coding_completed')).toThrow(/requires active evidence/);
 const failure=itemEvent(f,'failure_observed'),other=itemEvent(f,'failure_observed');
 expect(()=>itemEvent(f,'no_failure_observed')).toThrow(/conflicts/);
 const completion=itemEvent(f,'coding_completed');
 expect(()=>itemEvent(f,'failure_withdrawn',{target:failure})).toThrow(/must be reopened/);
 itemEvent(f,'coding_reopened',{target:completion});
 itemEvent(f,'failure_withdrawn',{target:failure});
 expect(()=>itemEvent(f,'failure_withdrawn',{target:failure})).toThrow(/active target/);
 itemEvent(f,'failure_withdrawn',{target:other});
 const none=itemEvent(f,'no_failure_observed');
 expect(()=>itemEvent(f,'failure_observed')).toThrow(/conflicts/);
 itemEvent(f,'no_failure_withdrawn',{target:none});
 itemEvent(f,'failure_observed');itemEvent(f,'coding_completed');
 expect(f.db.prepare("SELECT event_type FROM analysis_study_item_active_events ORDER BY version").all().map(r=>r.event_type)).toEqual(['failure_observed','coding_completed']);
 expect(()=>f.db.exec('DELETE FROM analysis_study_item_events')).toThrow(/project erasure/);
 expect(()=>f.db.exec("UPDATE analysis_study_item_events SET rationale='rewritten'")).toThrow(/immutable/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_study_item_events').all()).toEqual([]);
});
it.each([
 ['predecessor_event_digest','sha256:'+'a'.repeat(64)],['study_id','foreign'],['actor_role','member'],['actor_user_id','foreign'],['version',42],
 ['request_digest','sha256:'+'a'.repeat(64)],['event_digest','sha256:'+'a'.repeat(64)],['rationale','\t'],['occurred_at','2020-01-01T00:00:00.000Z']
])('rejects forged coding event %s',async(column,value)=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 expect(()=>itemEvent(f,'no_failure_observed',{override:{[column]:value}})).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_study_item_events').all()).toEqual([]);
});
it('rejects absent step anchors, wrong target digests, cross-item targets and coding at deadline',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 expect(()=>itemEvent(f,'failure_observed',{anchor:{kind:'step',stepIndex:0}})).toThrow(/anchor/);
 const failure=itemEvent(f,'failure_observed');
 expect(()=>itemEvent(f,'failure_withdrawn',{target:{...failure,event_digest:'sha256:'+'a'.repeat(64)}})).toThrow(/active target/);
 expect(()=>itemEvent(f,'failure_withdrawn',{itemId:'study-item-1',target:failure})).toThrow(/active target/);
 expect(()=>itemEvent(f,'coding_completed',{now:f.now+1000})).toThrow(/deadline/);
 itemEvent(f,'coding_completed',{now:f.now+999});
});

function itemView(f:Fixture,override:RecordValue={},now=f.now+4,actor={userId:f.userId,subjectId:'subject'}){
 return sqliteCommand(f.db,c=>{
  const exposure={id:'view-exposure',project_id:f.projectId,revision_id:'rev',revision_item_id:null,kind:'human_access',exposure_class:'development',activity:'content_view',subject_kind:'person',subject_id:actor.subjectId,actor_user_id:actor.userId,evidence_ref_kind:'analysis_population',evidence_ref_id:'ap',reason:null,details:'{}',idempotency_key:'view-exposure',occurred_at:c.timestamp};
  const columns=Object.keys(exposure);c.db.prepare(`INSERT INTO dataset_exposure_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(exposure));
  const basis={projectId:f.projectId,studyId:'study',studyItemId:'study-item-0',viewerUserId:actor.userId,viewerSubjectId:actor.subjectId,datasetRevisionId:'rev'};
  const requestDigest=analysisStudyItemViewRequestDigest(basis);
  const view={...basis,id:'view',idempotencyKey:'view',datasetExposureEventId:exposure.id,countsTowardClosure:true,requestDigest,viewedAt:c.timestamp};
  const row:RecordValue={id:'view',project_id:f.projectId,study_id:'study',study_item_id:'study-item-0',dataset_exposure_event_id:exposure.id,viewer_user_id:actor.userId,viewer_subject_id:actor.subjectId,idempotency_key:'view',request_digest:requestDigest,content_digest:analysisStudyItemViewContentDigest(view),counts_toward_closure:1,viewed_at:c.timestamp,...override};
  const keys=Object.keys(row);c.db.prepare(`INSERT INTO analysis_study_item_views(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
 },()=>now);
}
it('requires study content views to atomically bind exact exposure and preserve immutable history',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);
 expect(()=>itemView(f)).toThrow(/unavailable/);
 expect(f.db.prepare("SELECT * FROM dataset_exposure_events WHERE id='view-exposure'").get()).toBeUndefined();
 studyEvent(f);itemView(f);
 expect(f.db.prepare('SELECT counts_toward_closure FROM analysis_study_item_views').get()?.counts_toward_closure).toBe(1);
 expect(()=>f.db.exec('DELETE FROM analysis_study_item_views')).toThrow(/project erasure/);
 expect(()=>f.db.exec('UPDATE analysis_study_item_views SET counts_toward_closure=0')).toThrow(/immutable/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_study_item_views').all()).toEqual([]);
});
it.each([
 ['dataset_exposure_event_id','missing'],['viewer_user_id','foreign'],['study_id','foreign'],['counts_toward_closure',0],
 ['request_digest','sha256:'+'a'.repeat(64)],['content_digest','sha256:'+'a'.repeat(64)],['viewed_at','2020-01-01T00:00:00.000Z']
])('rejects forged study content view %s',async(column,value)=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);expect(()=>itemView(f,{[column]:value})).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_study_item_views').all()).toEqual([]);
 expect(f.db.prepare("SELECT * FROM dataset_exposure_events WHERE id='view-exposure'").get()).toBeUndefined();
});
it('requires overdue closure before another content view',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 expect(()=>itemView(f,{},f.now+1000)).toThrow(/overdue closure/);
 itemView(f,{},f.now+999);
});
it('accepts member-authored coding, retained step anchors and member content exposures',async()=>{
 const f=await fixture();
 sqliteCommand(f.db,c=>c.db.prepare("UPDATE cases SET normalized_payload=json_set(normalized_payload,'$.steps',json('[{\"input\":\"step input\",\"output\":\"step result\"}]')) WHERE project_id=?").run(f.projectId));
 freeze(f);draftStudy(f);studyEvent(f);
 const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'member@example.test',password:'synthetic-long-password',name:'Member'}});
 f.db.prepare('INSERT INTO project_members(id,project_id,user_id,role,created_at) VALUES(?,?,?,?,?)').run('member-membership',f.projectId,user.id,'member',new Date().toISOString());
 f.db.prepare('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,sqlite_subject_digest(?,?),?)').run('member-subject',f.projectId,user.id,f.projectId,'member-subject',new Date().toISOString());
 const actor={userId:user.id,subjectId:'member-subject',role:'member' as const};
 itemEvent(f,'failure_observed',{actor,anchor:{kind:'step',stepIndex:0}});itemView(f,{},f.now+4,actor);
 expect(f.db.prepare('SELECT actor_role,anchor_step_index FROM analysis_study_item_events').get()).toMatchObject({actor_role:'member',anchor_step_index:0});
 expect(f.db.prepare("SELECT subject_id FROM dataset_exposure_events WHERE id='view-exposure'").get()?.subject_id).toBe('member-subject');
});
function assignment(f:Fixture,observation:RecordValue,type:'assigned'|'withdrawn'='assigned',options:{now?:number;revisionId?:string;override?:RecordValue}={}){
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
it('preserves assignment successors and allows withdrawal against a retired current code',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);taxonomyRevision(f);
 const failure=itemEvent(f,'failure_observed');
 expect(()=>assignment(f,failure,'withdrawn')).toThrow(/ancestry/);
 assignment(f,failure);itemEvent(f,'coding_completed');
 assignment(f,failure,'withdrawn'); // Categorization can continue on completed coding while the study is open, matching PG.
 assignment(f,failure);
 taxonomyRevision(f,[taxonomyExisting('retired')]);
 expect(()=>assignment(f,failure,'assigned',{revisionId:'revision-1'})).toThrow(/current taxonomy head/);
 expect(()=>assignment(f,failure)).toThrow(/must be active/);
 assignment(f,failure,'withdrawn');
 expect(f.db.prepare('SELECT count(*) n FROM analysis_observation_assignment_events').get()?.n).toBe(4);
 expect(()=>f.db.exec('DELETE FROM analysis_observation_assignment_events')).toThrow(/project erasure/);
 expect(()=>f.db.exec("UPDATE analysis_observation_assignment_events SET rationale='rewritten'")).toThrow(/immutable/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_observation_assignment_events').all()).toEqual([]);
});
it.each([
 ['version',3],['predecessor_event_id','foreign'],['study_item_id','study-item-1'],['actor_user_id','foreign'],['actor_role','member'],['taxonomy_revision_sequence',2],
 ['request_digest','sha256:'+'a'.repeat(64)],['event_digest','sha256:'+'a'.repeat(64)],['rationale','\t'],['occurred_at','2020-01-01T00:00:00.000Z']
])('rejects forged observation assignment %s',async(column,value)=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);taxonomyRevision(f);const failure=itemEvent(f,'failure_observed');
 expect(()=>assignment(f,failure,'assigned',{override:{[column]:value}})).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_observation_assignment_events').all()).toEqual([]);
});
it('rejects assignments after withdrawal, abandonment or the exact study deadline',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});taxonomyRevision(f);
 const failure=itemEvent(f,'failure_observed');
 expect(()=>assignment(f,failure,'assigned',{now:f.now+1000})).toThrow(/deadline/);
 assignment(f,failure,'assigned',{now:f.now+999});
 itemEvent(f,'failure_withdrawn',{target:failure,now:f.now+999});
 expect(()=>assignment(f,failure,'withdrawn',{now:f.now+999})).toThrow(/active failure/);
 const other=await fixture();freeze(other);draftStudy(other);studyEvent(other);taxonomyRevision(other);const otherFailure=itemEvent(other,'failure_observed');studyEvent(other,'study_abandoned');
 expect(()=>assignment(other,otherFailure)).toThrow(/closed by state/);
});
