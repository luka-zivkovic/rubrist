import { expect,it,vi } from 'vitest';
import { fixture,freeze,draftStudy,studyEvent,itemEvent,assignment } from './helpers/sqlite-analysis.js';
import { revision,existing } from './helpers/sqlite-taxonomy.js';
import { sqliteStudyReadCommands } from '../src/storage/sqlite/study-read-commands.js';
import { sqliteStudyCommands } from '../src/storage/sqlite/study-commands.js';
import { sqlitePopulationCommands } from '../src/storage/sqlite/population-commands.js';

it('paginates exact item/event history and returns governed study and taxonomy views',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);revision(f);
 const observation=itemEvent(f,'failure_observed');assignment(f,observation);assignment(f,observation,'withdrawn');itemEvent(f,'coding_completed');
 revision(f,[existing('retired')]);
 const read=sqliteStudyReadCommands(f.db,()=>f.now+100),access={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 expect(read.studyGet(access,'study')).toMatchObject({summary:{completedItemCount:1},taxonomyCoverage:{uncategorized:'1'}});
 const items=read.studyItems(access,'study',{limit:1,cursor:null})!;
 expect(items.items).toHaveLength(1);expect(items.nextCursor).not.toBeNull();
 expect(read.studyItems(access,'study',{limit:1,cursor:items.nextCursor})?.items[0]?.item.position).toBe(1);
 const events=read.studyItemEvents(access,'study','study-item-0',{limit:1,cursor:null})!;
 expect(events.items[0]?.eventType).toBe('coding_completed');expect(events.totalCount).toBe('2');
 expect(read.studyItemEvents(access,'study','study-item-0',{limit:1,cursor:events.nextCursor})?.items[0]?.eventType).toBe('failure_observed');
 expect(read.studyTaxonomyGet(access)).toMatchObject({revision:{revision:{sequence:2}}});
 const revisions=read.studyTaxonomyRevisions(access,'taxonomy',{limit:1,cursor:null})!;
 expect(revisions.items[0]?.sequence).toBe(2);expect(read.studyTaxonomyRevisions(access,'taxonomy',{limit:1,cursor:revisions.nextCursor})?.items[0]?.sequence).toBe(1);
 const assignments=read.studyAssignments(access,'taxonomy',String(observation.id),{limit:1,cursor:null})!;
 expect(assignments.items[0]?.eventType).toBe('withdrawn');expect(read.studyAssignments(access,'taxonomy',String(observation.id),{limit:1,cursor:assignments.nextCursor})?.items[0]?.eventType).toBe('assigned');
 expect(read.studyItemGet(access,'study','foreign')).toBeNull();expect(read.studyTaxonomyRevisionGet(access,'foreign','revision-1')).toBeNull();
 expect(()=>read.studyGet({...access,projectId:'foreign'},'study')).toThrow(/forbidden/);
 expect(()=>read.studyItems(access,'study',{limit:0,cursor:null})).toThrow(/limit/);
 expect(()=>read.studyList(access,{limit:201,cursor:null})).toThrow(/limit/);
 expect(()=>read.studyItems(access,'study',{limit:1,cursor:events.nextCursor})).toThrow(/cursor/);
});
it.each(['study','item'])('rechecks deadline inside the final %s read transaction',async kind=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 const access={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};let sample=0;
 const read=sqliteStudyReadCommands(f.db,()=>f.now+(++sample<3?999:1000));
 const result=kind==='study'?read.studyGet(access,'study')?.summary.study:read.studyItemGet(access,'study','study-item-0')?.study;
 expect(result?.state).toBe('coding_closed');
 expect(f.db.prepare('SELECT close_actor_role FROM analysis_study_closures').get()?.close_actor_role).toBe('system');
});
it('paginates tied study timestamps and isolates a failed deadline closure from healthy work',async()=>{
 const f=await fixture();freeze(f);const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 let now=f.now+10;const write=sqliteStudyCommands(f.db,()=>now),read=sqliteStudyReadCommands(f.db,()=>now);
 const first=write.studyCreate(actor,{populationId:'ap',idempotencyKey:'first'}).study.study.id;
 const population=sqlitePopulationCommands(f.db).populationCreate(actor,{windowStart:'2020-01-01T00:00:00.000Z',windowEnd:new Date(f.now-60002).toISOString(),fixedBudget:2,idempotencyKey:'other-population'});
 const second=write.studyCreate(actor,{populationId:population.population.id,idempotencyKey:'second'}).study.study.id;
 const page=read.studyList(actor,{limit:1,cursor:null}),next=read.studyList(actor,{limit:1,cursor:page.nextCursor});
 expect(new Set([page.items[0]?.study.study.id,next.items[0]?.study.study.id])).toEqual(new Set([first,second]));expect(next.nextCursor).toBeNull();
 for(const id of [first,second])write.studyOpen(actor,id,{expectedVersion:'0',idempotencyKey:'open',stoppingRule:{kind:'server_deadline',closeAt:new Date(f.now+1000).toISOString()}});
 // The selected ID is generated internally, never external SQL input.
 f.db.exec(`CREATE TRIGGER test_one_closure_fault BEFORE INSERT ON analysis_study_closures WHEN NEW.study_id='${first}' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END`);
 now=f.now+1000;const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{expect(read.studyCloseDue(100)).toBe(1);expect(log).toHaveBeenCalledWith('analysis study deadline closure partial failure');}finally{log.mockRestore();}
 const result=read.studyList(actor,{limit:10,cursor:null});expect(result.totalCount).toBe('2');expect(result.unavailableDueClosureCount).toBe(1);expect(result.items[0]?.study.study.id).toBe(second);
 expect(read.studyCloseDue(100)).toBe(0);
 f.db.exec('DROP TRIGGER test_one_closure_fault');now=f.now+6000;
 expect(read.studyCloseDue(100)).toBe(1);expect(read.studyList(actor,{limit:10,cursor:null}).unavailableDueClosureCount).toBe(0);
});
