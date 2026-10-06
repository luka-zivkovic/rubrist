import { expect,it } from 'vitest';
import { fixture,freeze } from './helpers/sqlite-analysis.js';
import { sqliteStudyCommands } from '../src/storage/sqlite/study-commands.js';
import { studyProjection } from '../src/storage/sqlite/study-projections.js';

it('creates one permanent study per draw and preserves exact idempotent owner transitions',async()=>{
 const f=await fixture();freeze(f);const commands=sqliteStudyCommands(f.db,()=>f.now+10),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const created=commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'create'}),id=created.study.study.id;
 expect(created.reused).toBe(false);expect(commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'create'}).reused).toBe(true);
 expect(()=>commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'other'})).toThrow(expect.objectContaining({code:'analysis_study_draw_conflict',details:{studyId:id}}));
 expect(()=>commands.studyCreate(actor,{populationId:'foreign',idempotencyKey:'create'})).toThrow(/different input/);
 const open={expectedVersion:'0',idempotencyKey:'open',stoppingRule:{kind:'explicit_owner_close' as const,closeAt:null}};
 const opened=commands.studyOpen(actor,id,open);expect(opened.study.state).toBe('coding_open');
 const close={expectedVersion:'1',idempotencyKey:'close',reason:'Coding finished'};
 const closed=commands.studyClose(actor,id,close);expect(closed.study.state).toBe('coding_closed');
 expect(commands.studyOpen(actor,id,open).event).toEqual(opened.event);
 expect(commands.studyClose(actor,id,close).replayed).toBe(true);
 expect(()=>commands.studyComplete(actor,id,{expectedVersion:'2',idempotencyKey:'wrong',expectedClosureDigest:'sha256:'+'0'.repeat(64)})).toThrow();
 const completed=commands.studyComplete(actor,id,{expectedVersion:'2',idempotencyKey:'complete',expectedClosureDigest:closed.study.closureDigest!});
 expect(completed.study.state).toBe('completed');expect(completed.study.currentVersion).toBe('3');
 expect(()=>commands.studyAbandon(actor,id,{expectedVersion:'3',idempotencyKey:'abandon',reason:'Too late'})).toThrow();
});
it('rechecks current membership and rejects foreign study ownership',async()=>{
 const f=await fixture();freeze(f);const commands=sqliteStudyCommands(f.db,()=>f.now+10),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 expect(()=>commands.studyCreate({...actor,projectRole:'member'},{populationId:'ap',idempotencyKey:'create'})).toThrow(/forbidden/);
 const id=commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'create'}).study.study.id;
 expect(()=>commands.studyAbandon({...actor,projectId:'foreign'},id,{expectedVersion:'0',idempotencyKey:'abandon',reason:'Stop'})).toThrow(/forbidden/);
 f.db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?").run(f.projectId,f.userId);
 expect(()=>commands.studyAbandon(actor,id,{expectedVersion:'0',idempotencyKey:'abandon',reason:'Stop'})).toThrow(/forbidden/);
 expect(studyProjection(f.db,f.projectId,id)?.state).toBe('draft');
});
it('commits an overdue server closure even when a stale owner mutation fails',async()=>{
 const f=await fixture();freeze(f);let now=f.now+10;const commands=sqliteStudyCommands(f.db,()=>now),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const id=commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'create'}).study.study.id;
 commands.studyOpen(actor,id,{expectedVersion:'0',idempotencyKey:'open',stoppingRule:{kind:'server_deadline',closeAt:new Date(f.now+1000).toISOString()}});
 now=f.now+1000;
 expect(()=>commands.studyAbandon(actor,id,{expectedVersion:'1',idempotencyKey:'abandon',reason:'Stop'})).toThrow();
 expect(studyProjection(f.db,f.projectId,id)).toMatchObject({state:'coding_closed',currentVersion:'2'});
 expect(f.db.prepare('SELECT close_actor_role FROM analysis_study_closures WHERE study_id=?').get(id)?.close_actor_role).toBe('system');
});
it('enforces exact CAS and freezes a permanent abandoned study',async()=>{
 const f=await fixture();freeze(f);const commands=sqliteStudyCommands(f.db,()=>f.now+10),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const id=commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'create'}).study.study.id;
 expect(()=>commands.studyAbandon(actor,id,{expectedVersion:'1',idempotencyKey:'abandon',reason:'Stop'})).toThrow(/version/);
 const input={expectedVersion:'0',idempotencyKey:'abandon',reason:'Stop'};
 expect(commands.studyAbandon(actor,id,input).study.state).toBe('abandoned');expect(commands.studyAbandon(actor,id,input).replayed).toBe(true);
 expect(()=>commands.studyCreate(actor,{populationId:'ap',idempotencyKey:'new-study'})).toThrow(/permanent/);
});
it.each(['abandon','close'])('persists retry when the deadline arrives in the final %s transaction',async command=>{
 const f=await fixture();freeze(f);const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const setup=sqliteStudyCommands(f.db,()=>f.now+10),id=setup.studyCreate(actor,{populationId:'ap',idempotencyKey:'create'}).study.study.id;
 setup.studyOpen(actor,id,{expectedVersion:'0',idempotencyKey:'open',stoppingRule:{kind:'server_deadline',closeAt:new Date(f.now+1000).toISOString()}});
 // A repeatable storage fault after the deadline boundary must be backed off.
 f.db.exec("CREATE TRIGGER test_closure_fault BEFORE INSERT ON analysis_study_closures BEGIN SELECT RAISE(ABORT,'synthetic closure fault'); END");
 let sample=0;const commands=sqliteStudyCommands(f.db,()=>f.now+(++sample<3?999:1000));
 const input={expectedVersion:'1',idempotencyKey:'mutation',reason:'Owner command'};
 expect(()=>command==='abandon'?commands.studyAbandon(actor,id,input):commands.studyClose(actor,id,input)).toThrow();
 expect(studyProjection(f.db,f.projectId,id)?.state).toBe('coding_open');
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
 expect(f.db.prepare('SELECT failure_count,last_error_code FROM analysis_study_deadline_retry_state WHERE study_id=?').get(id)).toMatchObject({failure_count:1,last_error_code:'closure_failed'});
});
