import { analysisStudyClosureItemContentDigest } from '../src/lib/analysis-study.js';
import { camel } from '../src/storage/sqlite/evaluation-values.js';
import { expect, it } from 'vitest';
import { fixture,freeze,draftStudy,studyEvent,itemEvent,itemView,assignment, type RecordValue } from './helpers/sqlite-analysis.js';
import { closeStudy, completeStudy } from './helpers/sqlite-closure.js';
import { revision } from './helpers/sqlite-taxonomy.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
it('freezes complete coding, assignment and view evidence into a representative closure',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);revision(f);
 const failure=itemEvent(f,'failure_observed');assignment(f,failure);itemEvent(f,'coding_completed');
 itemEvent(f,'no_failure_observed',{itemId:'study-item-1'});itemEvent(f,'coding_completed',{itemId:'study-item-1'});itemView(f);
 const result=closeStudy(f);expect(result.representativeOfPopulationId).toBe('ap');expect(result.completedItemCount).toBe(2);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_study_closure_items').get()?.n).toBe(2);
 expect(()=>itemEvent(f,'failure_observed')).toThrow(/closure freezes/);expect(()=>assignment(f,failure)).toThrow(/closure freezes/);
 sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM cases WHERE project_id=?').run(f.projectId),()=>f.now+101);
 expect(f.db.prepare('SELECT representative_of_population_id FROM analysis_study_closures').get()?.representative_of_population_id).toBe('ap');
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('records incomplete coding and missing retained frames honestly',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);const incomplete=closeStudy(f);expect(incomplete.representativeReason).toBe('coding_not_complete');
 const other=await fixture();freeze(other);draftStudy(other);studyEvent(other);
 sqliteCommand(other.db,c=>c.db.prepare('DELETE FROM cases WHERE project_id=?').run(other.projectId),()=>other.now+99);
 expect(()=>closeStudy(other)).toThrow(/recomputed frame/);
 const unavailable=closeStudy(other,{frame:null});expect(unavailable.representativeReason).toBe('frame_not_reproducible');
});
it('materializes deadline closure at the frozen effective time even when recorded later',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);const deadline=new Date(f.now+1000).toISOString();studyEvent(f,'coding_opened',{deadline});
 expect(()=>closeStudy(f,{now:f.now+999})).toThrow();
 const result=closeStudy(f,{now:f.now+2000});expect(result.effectiveClosedAt).toBe(deadline);expect(result.recordedAt).toBe(new Date(f.now+2000).toISOString());expect(result.closeActorRole).toBe('system');
});
it.each([
 ['analysis_study_closures','recomputed_frame_digest','sha256:'+'a'.repeat(64)],['analysis_study_closures','recomputed_draw_digest','sha256:'+'a'.repeat(64)],
 ['analysis_study_closures','representative_reason',null],['analysis_study_closures','recorded_at','2020-01-01T00:00:00.000Z'],['analysis_study_closures','close_actor_user_id','foreign'],
 ['analysis_study_closure_items','study_item_id','foreign'],['analysis_study_closure_items','content_digest','sha256:'+'a'.repeat(64)],['analysis_study_closure_finalizations','command_token','foreign'],
 ['analysis_study_events','closure_digest','sha256:'+'a'.repeat(64)]
])('rejects forged closure %s %s',async(table,column,value)=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 expect(()=>closeStudy(f,{hook:(name,row)=>name===table?{...row,[column]:value}:row})).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
 expect(f.db.prepare('SELECT to_state FROM analysis_study_events ORDER BY version DESC LIMIT 1').get()?.to_state).toBe('coding_open');
});
it.each(['analysis_study_closure_items','analysis_study_events','analysis_study_closure_finalizations'])('rejects incomplete closure bundle %s',async table=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 expect(()=>closeStudy(f,{hook:(name,row)=>name===table?null:row})).toThrow();expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
});
it.each([
 'DELETE FROM cases', 'DELETE FROM raw_traces','UPDATE cases SET normalized_payload=normalized_payload','UPDATE raw_traces SET source_trace_id=source_trace_id'
])('keeps closure frame stable after finalization in its creating command: %s',async sql=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 expect(()=>closeStudy(f,{after:c=>c.db.exec(sql)})).toThrow(/closure frame source/);
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
});
it('allows later content access without adding it to the historical closure',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);closeStudy(f);itemView(f,{},f.now+101);
 expect(f.db.prepare('SELECT counts_toward_closure FROM analysis_study_item_views').get()?.counts_toward_closure).toBe(0);
 expect(f.db.prepare('SELECT viewed_item_count FROM analysis_study_closures').get()?.viewed_item_count).toBe(0);
 for(const table of ['analysis_study_closures','analysis_study_closure_items','analysis_study_closure_finalizations'])expect(()=>f.db.exec(`DELETE FROM ${table}`)).toThrow(/project erasure/);
 expect(()=>f.db.exec('UPDATE analysis_study_closures SET completed_item_count=2')).toThrow(/immutable/);
});
it('requires owner acknowledgment of the exact finalized closure before completion',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);closeStudy(f);
 expect(()=>completeStudy(f,'sha256:'+'a'.repeat(64))).toThrow(/exact finalized closure/);
 completeStudy(f);expect(f.db.prepare('SELECT to_state FROM analysis_study_events ORDER BY version DESC LIMIT 1').get()?.to_state).toBe('completed');
});
it('rejects a self-consistent item digest that forges retained view history',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);itemView(f);
 expect(()=>closeStudy(f,{hook:(table,row)=>{
  if(table!=='analysis_study_closure_items'||row.position!==0)return row;
  const forged:RecordValue={...row,view_event_ids:'[]',view_event_digests:'[]'};
  const parsed=camel(forged);for(const [key,value] of Object.entries(parsed))if(key.endsWith('Ids')||key.endsWith('Digests'))parsed[key]=JSON.parse(String(value));
  parsed.itemEventVersion=String(parsed.itemEventVersion);forged.content_digest=analysisStudyClosureItemContentDigest(parsed as never);return forged;
 }})).toThrow(/projections differ/);
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
});
it('rejects identity insertion after closure finalization in its creating command',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 expect(()=>closeStudy(f,{after:c=>{
  const original=c.db.prepare('SELECT * FROM case_input_identity_records WHERE source_case_id IN(SELECT case_id FROM analysis_population_members) LIMIT 1').get()!,row={...original,id:'late-identity'};
  c.db.prepare(`INSERT INTO case_input_identity_records(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));
 }})).toThrow(/closure frame identity/);
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
});
