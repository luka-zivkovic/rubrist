import { expect,it } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createNonsealedGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { openNonsealedGovernedBatch,getOrCreateNonsealedBlindView } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
async function prepared(){const f=await governedDraftFixture(),batchId=createNonsealedGovernedDraft(f.db,f.actor,f.input),taskId=String(f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').get(batchId)!.id);openNonsealedGovernedBatch(f.db,f.actor,batchId,{expectedStateVersion:0,idempotencyKey:'open'});const view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);return {...f,batchId,taskId,view};}
const input=(viewDigest:string,expectedStreamVersion=1,idempotencyKey='submit')=>({viewDigest,expectedStreamVersion,idempotencyKey,label:'pass' as const,rationale:'The answer satisfies the criterion.',failureCodes:[]});
it('atomically binds label attempts, withdrawals, current-state replay and exact digest history',async()=>{
 const f=await prepared(),firstInput=input(f.view.viewDigest);
 const first=action(f.db,f.actor,f.taskId,{kind:'submit_label',input:firstInput});expect(first).toMatchObject({state:'submitted',stateVersion:2,activeLabelId:expect.any(String)});
 const row=f.db.prepare('SELECT * FROM governed_review_labels WHERE id=?').get(first.activeLabelId!)!;
 expect(row.content_digest).toBe(governedContentV1Digest('governed-review-label/v1',{attempt:1,blindViewDigest:f.view.viewDigest,failureCodes:[],label:'pass',rationale:firstInput.rationale,replacesLabelId:null,reviewerSubjectId:row.reviewer_subject_id,taskId:f.taskId}));
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_label_finalizations').get()?.n).toBe(1);
 const withdrawn=action(f.db,f.actor,f.taskId,{kind:'withdraw_label',input:{expectedStreamVersion:2,idempotencyKey:'withdraw',labelId:first.activeLabelId!,reason:'Correct rationale'}});expect(withdrawn).toMatchObject({state:'withdrawn',stateVersion:3,activeLabelId:null});
 expect(action(f.db,f.actor,f.taskId,{kind:'submit_label',input:firstInput})).toEqual(withdrawn);
 expect(()=>action(f.db,f.actor,f.taskId,{kind:'submit_label',input:{...firstInput,label:'fail'}})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest,2,'stale')})).toThrow(expect.objectContaining({code:'governed_review_stream_conflict'}));
 const second=action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest,3,'replacement')});
 expect(f.db.prepare('SELECT attempt,replaces_label_id FROM governed_review_labels WHERE id=?').get(second.activeLabelId!)).toEqual({attempt:2,replaces_label_id:first.activeLabelId});
 expect(()=>f.db.exec("UPDATE governed_review_labels SET rationale='overwrite'")).toThrow(/immutable/);
 const plain=new DatabaseSync(f.path);cleanup.push(()=>plain.close());expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');expect(plain.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM governed_review_labels').all()).toEqual([]);
});
it('supports defer/resume with live reviewer scope and the public idempotency namespace',async()=>{
 const f=await prepared();expect(action(f.db,f.actor,f.taskId,{kind:'defer',input:{reason:'Later',expectedStreamVersion:1,idempotencyKey:'defer'}}).state).toBe('deferred');
 expect(()=>action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest,2)})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 expect(action(f.db,f.actor,f.taskId,{kind:'resume',input:{expectedStreamVersion:2,idempotencyKey:'resume'}}).state).toBe('viewed');
 expect(()=>action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest,3,'x'.repeat(201))})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 expect(()=>action(f.db,{...f.actor,userId:'foreign'},f.taskId,{kind:'submit_label',input:input(f.view.viewDigest,3)})).toThrow();
 f.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.projectId,f.userId);
 expect(()=>action(f.db,f.actor,f.taskId,{kind:'resume',input:{expectedStreamVersion:2,idempotencyKey:'resume'}})).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
});
it.each(['digest','view','attempt','reviewer','failure-codes','rationale','orphan','fake-finalizer'])('rolls back direct SQL %s labels and prevents detached evidence',async fault=>{
 const f=await prepared();
 expect(()=>sqliteCommand(f.db,c=>{
  const subject=String(c.db.prepare('SELECT reviewer_subject_id FROM governed_review_tasks WHERE id=?').get(f.taskId)!.reviewer_subject_id);
  const basis={attempt:fault==='attempt'?2:1,blindViewDigest:fault==='view'?'sha256:'+'0'.repeat(64):f.view.viewDigest,failureCodes:fault==='failure-codes'?['']:[],label:'pass',rationale:fault==='rationale'?'é'.repeat(20000):'ok',replacesLabelId:null,reviewerSubjectId:fault==='reviewer'?'foreign':subject,taskId:f.taskId};
  const row:Record<string,SQLInputValue>={id:'forged',project_id:f.projectId,task_id:f.taskId,reviewer_subject_id:basis.reviewerSubjectId,attempt:basis.attempt,label:basis.label,rationale:basis.rationale,failure_codes:JSON.stringify(basis.failureCodes),blind_view_digest:basis.blindViewDigest,replaces_label_id:null,content_digest:fault==='digest'?'sha256:'+'0'.repeat(64):governedContentV1Digest('governed-review-label/v1',basis),idempotency_key:'forged',request_digest:'sha256:'+'0'.repeat(64),created_at:c.timestamp,created_command_token:c.token};
  c.db.prepare(`INSERT INTO governed_review_labels(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  if(fault==='fake-finalizer')c.db.prepare('INSERT INTO governed_review_label_finalizations(label_id,project_id,task_id,command_token,event_id) VALUES(?,?,?,?,?)').run('forged',f.projectId,f.taskId,c.token,'missing');
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_review_labels').get()?.n).toBe(0);expect(f.db.prepare('SELECT state FROM governed_review_task_states WHERE task_id=?').get(f.taskId)?.state).toBe('viewed');
});
it('rolls back a label if its submission event cannot be written',async()=>{
 const f=await prepared();f.db.exec("CREATE TRIGGER test_fail_submission BEFORE INSERT ON governed_review_task_events WHEN NEW.event_kind='label_submitted' BEGIN SELECT RAISE(ABORT,'injected event failure'); END;");
 expect(()=>action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest)})).toThrow(/injected event failure/);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_labels').get()?.n).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM governed_review_label_finalizations').get()?.n).toBe(0);
});

it('submits a persisted view on a fresh peer connection',async()=>{
 const f=await prepared(),peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);
 const submitted=action(peer,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest)});
 expect(submitted).toMatchObject({state:'submitted',stateVersion:2,activeLabelId:expect.any(String)});
 expect(f.db.prepare('SELECT label_id FROM governed_active_review_labels WHERE task_id=?').get(f.taskId)?.label_id).toBe(submitted.activeLabelId);
});
import {interceptSqliteInsert} from './helpers/sqlite-insert-intercept.js';
import {taskEventContent} from '../src/governed-review/storage-values.js';
it.each(['withdrawal','replacement'])('rejects wrong direct label %s lineage with a recomputed digest',async kind=>{
 const f=await prepared(),first=action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest)});
 if(kind==='replacement')action(f.db,f.actor,f.taskId,{kind:'withdraw_label',input:{expectedStreamVersion:2,idempotencyKey:'withdraw',labelId:first.activeLabelId!,reason:'Correction'}});
 const spy=interceptSqliteInsert(f.db,kind==='withdrawal'?'governed_review_task_events':'governed_review_labels',row=>{
  if(kind==='withdrawal'){
   row.label_id='foreign';row.event_digest=governedContentV1Digest('governed-review-task-event/v1',taskEventContent({actorRoleAtReview:String(row.actor_role_at_review),actorSubjectId:String(row.actor_subject_id),eventKind:String(row.event_kind),labelId:'foreign',reason:String(row.reason),taskId:f.taskId,sequence:Number(row.sequence),previousEventDigest:String(row.previous_event_digest)}));
  }else{
   row.replaces_label_id='foreign';row.content_digest=governedContentV1Digest('governed-review-label/v1',{attempt:row.attempt,blindViewDigest:row.blind_view_digest,failureCodes:JSON.parse(String(row.failure_codes)),label:row.label,rationale:row.rationale,replacesLabelId:'foreign',reviewerSubjectId:row.reviewer_subject_id,taskId:row.task_id});
  }return row;
 });
 try{expect(()=>kind==='withdrawal'?action(f.db,f.actor,f.taskId,{kind:'withdraw_label',input:{expectedStreamVersion:2,idempotencyKey:'bad-withdraw',labelId:first.activeLabelId!,reason:'Correction'}}):action(f.db,f.actor,f.taskId,{kind:'submit_label',input:input(f.view.viewDigest,3,'bad-replacement')})).toThrow(/active label|prior label|replacement|previous attempt/);}finally{spy.mockRestore();}
});
