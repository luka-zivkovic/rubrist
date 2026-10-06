import { expect,it } from 'vitest';
import { fixture,freeze,draftStudy,studyEvent } from './helpers/sqlite-analysis.js';
import { closeStudy } from './helpers/sqlite-closure.js';
import { sqliteStudyItemCommands } from '../src/storage/sqlite/study-item-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { studyClosure } from '../src/storage/sqlite/study-projections.js';

it('records exact member coding events and preserves historical replay after closure',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'member@example.test',password:'synthetic-long-password',name:'Member'}});
 f.db.prepare('INSERT INTO project_members(id,project_id,user_id,role,created_at) VALUES(?,?,?,?,?)').run('member',f.projectId,user.id,'member',new Date().toISOString());
 let now=f.now+10;const commands=sqliteStudyItemCommands(f.db,()=>now),actor={projectId:f.projectId,userId:user.id,projectRole:'member' as const};
 const input={eventType:'failure_observed' as const,expectedVersion:'0',idempotencyKey:'observe',failureLabel:'Omitted context',rationale:'Missing required detail',evidenceAnchor:{kind:'case_output' as const}};
 const observed=commands.studyItemAppend(actor,'study','study-item-0',input);
 expect(observed.event.actorRole).toBe('member');expect(observed.item.activeFailureObservationEventIds).toEqual([observed.event.id]);
 expect(()=>commands.studyItemAppend(actor,'study','study-item-0',{...input,failureLabel:'Other'})).toThrow(/different input/);
 expect(()=>commands.studyItemAppend(actor,'study','study-item-0',{...input,idempotencyKey:'stale'})).toThrow(/version/);
 const completed=commands.studyItemAppend(actor,'study','study-item-0',{eventType:'coding_completed',expectedVersion:'1',idempotencyKey:'complete'});
 expect(completed.item.state).toBe('completed');
 closeStudy(f);now=f.now+101;
 expect(commands.studyItemAppend(actor,'study','study-item-0',input).event).toEqual(observed.event);
 expect(()=>commands.studyItemAppend(actor,'study','study-item-0',{eventType:'coding_reopened',expectedVersion:'2',idempotencyKey:'reopen',targetEventId:completed.event.id,targetEventDigest:completed.event.eventDigest,rationale:'Revise'})).toThrow(/not open/);
});
it('deduplicates content views, persists exposure before returning content and freezes closure participation',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};let now=f.now+10;
 const commands=sqliteStudyItemCommands(f.db,()=>now);
 expect(()=>commands.studyItemContent(actor,'study','study-item-0')).toThrow(/unavailable/);
 expect(f.db.prepare("SELECT * FROM dataset_exposure_events WHERE kind='human_access'").all()).toEqual([]);
 studyEvent(f);const first=commands.studyItemContent(actor,'study','study-item-0')!;
 expect(first.payloadSnapshot.output).toBe('Answer');expect(commands.studyItemContent(actor,'study','study-item-0')?.viewEventId).toBe(first.viewEventId);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_study_item_views').get()?.n).toBe(1);
 // A new request key cannot inflate one person's contribution to a study item.
 expect(()=>sqliteCommand(f.db,c=>{
  const row=c.db.prepare('SELECT * FROM analysis_study_item_views WHERE id=?').get(first.viewEventId)!;
  row.id='duplicate';row.idempotency_key='different-key';
  c.db.prepare(`INSERT INTO analysis_study_item_views VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 },()=>now)).toThrow(/UNIQUE/);
 closeStudy(f);now=f.now+101;
 const second=commands.studyItemContent(actor,'study','study-item-1')!;
 expect(second.datasetExposureEventId).toBe(first.datasetExposureEventId);
 expect(f.db.prepare('SELECT counts_toward_closure FROM analysis_study_item_views WHERE id=?').get(second.viewEventId)?.counts_toward_closure).toBe(0);
 expect(studyClosure(f.db,f.projectId,'study')?.viewedItemCount).toBe(1);
 expect(()=>commands.studyItemContent({...actor,projectId:'foreign'},'study','study-item-0')).toThrow(/forbidden/);
});
it('materializes overdue closure before returning content and rejects invalid anchors atomically',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f,'coding_opened',{deadline:new Date(f.now+1000).toISOString()});
 const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};let now=f.now+10;const commands=sqliteStudyItemCommands(f.db,()=>now);
 expect(()=>commands.studyItemAppend(actor,'study','study-item-0',{eventType:'failure_observed',expectedVersion:'0',idempotencyKey:'invalid',failureLabel:'Missing detail',rationale:'Inspect step',evidenceAnchor:{kind:'step',stepIndex:0}})).toThrow(/anchor/i);
 expect(f.db.prepare('SELECT * FROM analysis_study_item_events').all()).toEqual([]);
 now=f.now+1000;const content=commands.studyItemContent(actor,'study','study-item-0')!;
 expect(studyClosure(f.db,f.projectId,'study')?.closeCause).toBe('server_deadline');
 expect(f.db.prepare('SELECT counts_toward_closure FROM analysis_study_item_views WHERE id=?').get(content.viewEventId)?.counts_toward_closure).toBe(0);
});
it('rolls back the new exposure if the later view insert fails',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};const commands=sqliteStudyItemCommands(f.db,()=>f.now+10);
 f.db.exec("CREATE TRIGGER test_view_fault BEFORE INSERT ON analysis_study_item_views BEGIN SELECT RAISE(ABORT,'synthetic view fault'); END");
 expect(()=>commands.studyItemContent(actor,'study','study-item-0')).toThrow();
 expect(f.db.prepare("SELECT * FROM dataset_exposure_events WHERE kind='human_access'").all()).toEqual([]);
 expect(f.db.prepare('SELECT * FROM analysis_study_item_views').all()).toEqual([]);
});
