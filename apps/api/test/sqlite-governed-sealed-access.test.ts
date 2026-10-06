import { expect,it } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { governedSealedDraftFixture } from './helpers/sqlite-governed-sealed-draft.js';
import { createGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as view } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { taskEventContent } from '../src/governed-review/storage-values.js';
async function prepared(){const f=await governedSealedDraftFixture(true),batchId=createGovernedDraft(f.db,f.actor,f.input);transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});const task=f.db.prepare('SELECT t.* FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=? AND s.account_user_id=?').get(batchId,f.reviewers[0]!)!,reviewer={...f.actor,userId:f.reviewers[0]!,projectRole:'member' as const};return {...f,batchId,task,reviewer,taskId:String(task.id)};}
function expose(f:Awaited<ReturnType<typeof prepared>>){sqliteCommand(f.db,c=>c.db.prepare("INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'human_access','development','content_view','person',?,NULL,'dataset_revision',?,NULL,'{}',?,?)").run('exposed',f.projectId,f.revision.id,f.reviewers[0]!,f.revision.id,'exposed',c.timestamp));}
it('opens only after fresh separation for every custodian and reviewer and retains immutable views',async()=>{
 const f=await prepared();expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE batch_id=? AND result='eligible'").get(f.batchId)?.n).toBe(3);
 const first=view(f.db,f.reviewer,f.taskId);expect(view(f.db,f.reviewer,f.taskId)).toEqual(first);expect(Buffer.from(first.canonicalBytes).toString()).toContain('Protected');
 const label=action(f.db,f.reviewer,f.taskId,{kind:'submit_label',input:{viewDigest:first.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});expect(label.state).toBe('submitted');
});
it('persists failed opening capability evidence without exposing or transitioning the batch',async()=>{
 const f=await governedSealedDraftFixture(),id=createGovernedDraft(f.db,f.actor,f.input);
 expect(()=>transition(f.db,f.actor,id,'open',{expectedStateVersion:0,idempotencyKey:'open'})).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));
 expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(id)?.state).toBe('draft');expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE result='ineligible'").get()?.n).toBe(1);expect(f.db.prepare('SELECT * FROM governed_review_task_events').all()).toEqual([]);
});
it('rejects retained blind-view replay and label replay after later development exposure',async()=>{
 const f=await prepared(),first=view(f.db,f.reviewer,f.taskId),input={kind:'submit_label' as const,input:{viewDigest:first.viewDigest,label:'pass' as const,rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}};
 action(f.db,f.reviewer,f.taskId,input);expose(f);
 expect(()=>view(f.db,f.reviewer,f.taskId)).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));expect(()=>action(f.db,f.reviewer,f.taskId,input)).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));
 expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE subject_id=? AND result='ineligible'").get(f.task.reviewer_subject_id!)?.n).toBeGreaterThan(0);expect(f.db.prepare('SELECT count(*) n FROM governed_review_labels').get()?.n).toBe(1);
});
it('rejects a direct task write against a formerly eligible snapshot whose facts changed',async()=>{
 const f=await prepared();view(f.db,f.reviewer,f.taskId);expose(f);
 const prior=f.db.prepare("SELECT * FROM governed_review_task_events WHERE task_id=? AND event_kind='viewed'").get(f.taskId)!;
 expect(()=>sqliteCommand(f.db,c=>{const basis=taskEventContent({actorRoleAtReview:'member',actorSubjectId:String(f.task.reviewer_subject_id),eventKind:'deferred',taskId:f.taskId,sequence:2,previousEventDigest:String(prior.event_digest),reason:'Pause'});
 const row:Record<string,SQLInputValue>={id:'forged',project_id:f.projectId,task_id:f.taskId,sequence:2,state_version:2,expected_previous_state_version:1,event_kind:'deferred',actor_subject_id:f.task.reviewer_subject_id!,actor_role_at_review:'member',reason:'Pause',previous_event_digest:prior.event_digest!,event_digest:governedContentV1Digest('governed-review-task-event/v1',basis),idempotency_key:'forged',request_digest:'sha256:'+'a'.repeat(64),occurred_at:c.timestamp};
 c.db.prepare(`INSERT INTO governed_review_task_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));})).toThrow(/separation/);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_task_events').get()?.n).toBe(1);
});
it('gates sealed alignment and adjudication with independent live author checks',async()=>{
 const f=await prepared();
 for(const [index,userId] of f.reviewers.entries()){
  const actor={...f.reviewer,userId},taskId=String(f.db.prepare('SELECT t.id FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=? AND s.account_user_id=?').get(f.batchId,userId)!.id),artifact=view(f.db,actor,taskId);
  action(f.db,actor,taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:index?'fail':'pass',rationale:'Independent opinion',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});transition(f.db,f.actor,f.batchId,'open_alignment',{expectedStateVersion:2,idempotencyKey:'align'});
 const {appendNonsealedGovernedAlignment:align}=await import('../src/storage/sqlite/governed-alignment-commands.js');
 const input={kind:'comment_recorded' as const,content:'Discuss evidence',expectedAlignmentVersion:0,idempotencyKey:'note'};
 expect(()=>align(f.db,f.actor,f.batchId,input)).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));expect(align(f.db,f.custodian,f.batchId,input).sequence).toBe(1);
 align(f.db,f.custodian,f.batchId,{kind:'closed',content:'Ready',expectedAlignmentVersion:1,idempotencyKey:'aligned'});transition(f.db,f.actor,f.batchId,'start_adjudication',{expectedStateVersion:3,idempotencyKey:'adjudicate'});
 const {appendNonsealedGovernedAdjudication:adjudicate}=await import('../src/storage/sqlite/governed-adjudication-commands.js');
 const adjudication={decision:'pass' as const,rationale:'Supported',basis:'Exact labels',expectedHeadAdjudicationId:null,idempotencyKey:'decision'};
 expect(()=>adjudicate(f.db,f.actor,f.batchId,String(f.task.batch_item_id),adjudication)).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));expect(adjudicate(f.db,f.custodian,f.batchId,String(f.task.batch_item_id),adjudication).decision).toBe('pass');
});
