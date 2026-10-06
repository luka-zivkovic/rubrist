import { expect, it } from 'vitest';
import { openSqlite } from '@rubrist/db/sqlite';
import { fixture,freeze,draftStudy,studyEvent } from './helpers/sqlite-analysis.js';
import { closeStudy } from './helpers/sqlite-closure.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { clearStudyDeadlineFailure,dueStudyCandidates,recordStudyDeadlineFailure } from '../src/storage/sqlite/study-deadlines.js';

async function dueFixture(){
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});return f;
}
it('persists bounded retry backoff across restart and uses the exact due boundary',async()=>{
 const f=await dueFixture();const clock=()=>f.now+1000;
 expect(dueStudyCandidates(f.db,100,()=>f.now+999)).toEqual([]);
 expect(dueStudyCandidates(f.db,100,clock)).toEqual([{projectId:f.projectId,studyId:'study'}]);
 recordStudyDeadlineFailure(f.db,f.projectId,'study',clock);
 const restarted=openSqlite(f.path);sqliteCommands(restarted);
 try {
  expect(dueStudyCandidates(restarted,100,()=>f.now+5999)).toEqual([]);
  expect(dueStudyCandidates(restarted,100,()=>f.now+6000)).toHaveLength(1);
  for(let count=2;count<=14;count++){
   recordStudyDeadlineFailure(restarted,f.projectId,'study',()=>f.now+6000);
   const row=restarted.prepare('SELECT * FROM analysis_study_deadline_retry_state').get()!;
   expect(row.failure_count).toBe(count);expect(row.last_error_code).toBe('closure_failed');
   expect(Date.parse(String(row.next_retry_at))-Date.parse(String(row.last_failed_at))).toBe(Math.min(3600,5*2**Math.min(count-1,10))*1000);
  }
 }finally{restarted.close();}
});
it('ignores foreign, not-yet-due and closed studies and clears retry state atomically',async()=>{
 const f=await dueFixture();
 recordStudyDeadlineFailure(f.db,f.projectId,'study',()=>f.now+999);
 recordStudyDeadlineFailure(f.db,'foreign','study',()=>f.now+1000);
 expect(f.db.prepare('SELECT * FROM analysis_study_deadline_retry_state').all()).toEqual([]);
 recordStudyDeadlineFailure(f.db,f.projectId,'study',()=>f.now+1000);
 closeStudy(f,{now:f.now+2000,after:c=>clearStudyDeadlineFailure(c,f.projectId,'study')});
 recordStudyDeadlineFailure(f.db,f.projectId,'study',()=>f.now+3000);
 expect(f.db.prepare('SELECT * FROM analysis_study_deadline_retry_state').all()).toEqual([]);
 expect(dueStudyCandidates(f.db,100,()=>f.now+100000)).toEqual([]);
});
it('retains retry state when the closure transaction rolls back',async()=>{
 const f=await dueFixture();recordStudyDeadlineFailure(f.db,f.projectId,'study',()=>f.now+1000);
 expect(()=>closeStudy(f,{now:f.now+2000,after:c=>{clearStudyDeadlineFailure(c,f.projectId,'study');throw new Error('interrupted');}})).toThrow('interrupted');
 expect(f.db.prepare('SELECT failure_count FROM analysis_study_deadline_retry_state').get()?.failure_count).toBe(1);
 expect(f.db.prepare('SELECT * FROM analysis_study_closures').all()).toEqual([]);
});
it.each(['failure_count=99','next_retry_at=last_failed_at','last_error_code=\'private payload\'','project_id=\'foreign\''])('rejects forged retry updates: %s',async update=>{
 const f=await dueFixture();recordStudyDeadlineFailure(f.db,f.projectId,'study',()=>f.now+1000);
 expect(()=>sqliteCommand(f.db,c=>c.db.exec(`UPDATE analysis_study_deadline_retry_state SET ${update}`),()=>f.now+2000)).toThrow();
 expect(f.db.prepare('SELECT failure_count FROM analysis_study_deadline_retry_state').get()?.failure_count).toBe(1);
});
it.each([0,1001,1.5,NaN])('rejects invalid batch size %s',async limit=>{
 const f=await fixture();expect(()=>dueStudyCandidates(f.db,limit)).toThrow('deadline batch limit is invalid');
});
