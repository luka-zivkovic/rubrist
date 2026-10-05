import { expect,it } from 'vitest';
import { fixture,freeze,draftStudy,studyEvent,itemEvent,itemView } from './helpers/sqlite-analysis.js';
import { closeStudyIfDue,materializeStudyClosure } from '../src/storage/sqlite/study-closure.js';
import { studyClosure } from '../src/storage/sqlite/study-projections.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { analysisStudyEventRequestDigest } from '../src/lib/analysis-study.js';
import { recordStudyDeadlineFailure } from '../src/storage/sqlite/study-deadlines.js';

it('creates and replays an exact representative closure with independent database validation',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);itemView(f);
 for(const itemId of ['study-item-0','study-item-1']){itemEvent(f,'no_failure_observed',{itemId});itemEvent(f,'coding_completed',{itemId});}
 const input={projectId:f.projectId,studyId:'study',idempotencyKey:'owner-close',requestDigest:analysisStudyEventRequestDigest({studyId:'study',expectedVersion:'1',eventType:'coding_closed',reason:'Finished coding'}),closeCause:'explicit_owner_close' as const,closeActorUserId:f.userId,closeActorSubjectId:'subject',closeReason:'Finished coding',expectedVersion:'1'};
 const result=sqliteCommand(f.db,c=>materializeStudyClosure(f.db,c,input),()=>f.now+100);
 expect(result.replayed).toBe(false);expect(result.study.state).toBe('coding_closed');
 expect(studyClosure(f.db,f.projectId,'study')).toMatchObject({representativeOfPopulationId:'ap',completedItemCount:2,viewedItemCount:1});
 const replay=sqliteCommand(f.db,c=>materializeStudyClosure(f.db,c,input),()=>f.now+101);
 expect(replay.event).toEqual(result.event);expect(replay.replayed).toBe(true);
 expect(()=>sqliteCommand(f.db,c=>materializeStudyClosure(f.db,c,{...input,requestDigest:'sha256:'+'0'.repeat(64)}),()=>f.now+102)).toThrow(/different input/);
});
it('closes at the server deadline after a recorded retry and clears backoff atomically',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 expect(sqliteCommand(f.db,c=>closeStudyIfDue(f.db,c,f.projectId,'study'),()=>f.now+999)).toBe(false);
 recordStudyDeadlineFailure(f.db,f.projectId,'study',()=>f.now+1000);
 expect(sqliteCommand(f.db,c=>closeStudyIfDue(f.db,c,f.projectId,'study'),()=>f.now+6000)).toBe(true);
 expect(studyClosure(f.db,f.projectId,'study')).toMatchObject({effectiveClosedAt:new Date(f.now+1000).toISOString(),recordedAt:new Date(f.now+6000).toISOString(),closeActorRole:'system'});
 expect(f.db.prepare('SELECT * FROM analysis_study_deadline_retry_state').all()).toEqual([]);
 expect(sqliteCommand(f.db,c=>closeStudyIfDue(f.db,c,f.projectId,'study'),()=>f.now+6001)).toBe(false);
});
it('records unavailable retained frames without inventing representativeness',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 sqliteCommand(f.db,c=>c.db.exec('DELETE FROM cases'),()=>f.now+100);
 expect(sqliteCommand(f.db,c=>closeStudyIfDue(f.db,c,f.projectId,'study'),()=>f.now+1000)).toBe(true);
 expect(studyClosure(f.db,f.projectId,'study')).toMatchObject({recomputedFrameDigest:null,representativeOfPopulationId:null,representativeReason:'frame_not_reproducible'});
});
