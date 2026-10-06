import { expect,it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createNonsealedGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { taskEventContent } from '../src/governed-review/storage-values.js';
async function prepared(budget=1){const f=await governedDraftFixture(),batchId=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,selection:{method:'simple_random',fixedBudget:budget}}),tasks=f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=? ORDER BY id').all(batchId).map(t=>String(t.id));transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});return {...f,batchId,tasks};}
it('closes a complete batch before the stop, preserves label privacy barrier and resolves exact truth',async()=>{
 const f=await prepared(),taskId=f.tasks[0]!,view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);
 expect(()=>transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'too-early'})).toThrow();
 action(f.db,f.actor,taskId,{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[]}});
 const close=transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 expect(JSON.parse(String(f.db.prepare('SELECT details FROM governed_review_batch_events WHERE id=?').get(close)!.details))).toMatchObject({closedAtFixedStop:false,expiredTaskIds:[],deferredTaskIds:[],activeLabelIds:[expect.any(String)]});
 expect(()=>action(f.db,f.actor,taskId,{kind:'withdraw_label',input:{expectedStreamVersion:2,idempotencyKey:'withdraw',labelId:String(f.db.prepare('SELECT label_id FROM governed_active_review_labels').get()!.label_id),reason:'Too late'}})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 transition(f.db,f.actor,f.batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('resolved');
 expect(f.db.prepare('SELECT resolution_kind,resolved_label FROM governed_review_item_resolutions WHERE batch_id=?').get(f.batchId)).toEqual({resolution_kind:'single_rater',resolved_label:'pass'});
});
it('expires every pending task atomically on a fresh connection while keeping deferred tasks unchanged',async()=>{
 const f=await prepared(3),[assigned,viewed,deferred]=f.tasks as [string,string,string];
 getOrCreateNonsealedBlindView(f.db,f.actor,viewed);getOrCreateNonsealedBlindView(f.db,f.actor,deferred);
 action(f.db,f.actor,deferred,{kind:'defer',input:{expectedStreamVersion:1,idempotencyKey:'defer',reason:'Insufficient context'}});
 const peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);
 const atStop=()=>Date.parse(f.input.fixedStopAt),close=transition(peer,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'},atStop);
 const events=peer.prepare("SELECT * FROM governed_review_task_events WHERE event_kind='expired' ORDER BY task_id").all();expect(events).toHaveLength(2);
 for(const e of events){expect(e.actor_subject_id).toBeNull();expect(e.event_digest).toBe(governedContentV1Digest('governed-review-task-event/v1',taskEventContent({actorRoleAtReview:null,actorSubjectId:null,eventKind:'expired',reason:'fixed_stop',taskId:String(e.task_id),sequence:Number(e.sequence),previousEventDigest:e.previous_event_digest===null?null:String(e.previous_event_digest)})));}
 expect(peer.prepare('SELECT state FROM governed_review_task_states WHERE task_id=?').get(deferred)?.state).toBe('deferred');
 expect(JSON.parse(String(peer.prepare('SELECT details FROM governed_review_batch_events WHERE id=?').get(close)!.details))).toMatchObject({closedAtFixedStop:true,expiredTaskIds:[assigned,viewed].sort(),deferredTaskIds:[deferred]});
 expect(transition(peer,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'},atStop)).toBe(close);
 transition(peer,f.actor,f.batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'incomplete'},atStop);
 expect(peer.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('incomplete');
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(peer.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('rolls back all generated expiries if closure fails',async()=>{
 const f=await prepared(3);f.db.exec("CREATE TRIGGER test_reject_closure AFTER INSERT ON governed_review_batch_events WHEN NEW.event_kind='labeling_closed' BEGIN SELECT RAISE(ABORT,'injected closure failure'); END;");
 expect(()=>transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'},()=>Date.parse(f.input.fixedStopAt))).toThrow(/injected closure failure/);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_task_events').get()?.n).toBe(0);expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('open');
});
it('does not treat cannot-determine as resolved truth',async()=>{
 const f=await prepared(),taskId=f.tasks[0]!,view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);
 action(f.db,f.actor,taskId,{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:'cannot_determine',rationale:'Unclear',failureCodes:[]}});
 transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 expect(f.db.prepare('SELECT resolution_kind FROM governed_review_item_resolutions WHERE batch_id=?').get(f.batchId)?.resolution_kind).toBe('conflict');
 expect(()=>transition(f.db,f.actor,f.batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
});

it('preserves microsecond precision when classifying closure before the fixed stop',async()=>{
 const f=await governedDraftFixture(),millis=Math.ceil((Date.now()+3600000)/1000)*1000;
 const fixedStopAt=new Date(millis).toISOString().replace('.000Z','.000001Z');
 const batchId=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,fixedStopAt}),taskId=String(f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').get(batchId)!.id);
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 const view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);
 expect(()=>transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'pending'},()=>millis)).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 action(f.db,f.actor,taskId,{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[]}},()=>millis);
 const id=transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'},()=>millis);
 expect(JSON.parse(String(f.db.prepare('SELECT details FROM governed_review_batch_events WHERE id=?').get(id)!.details)).closedAtFixedStop).toBe(false);
});
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {interceptSqliteInsert} from './helpers/sqlite-insert-intercept.js';
it.each(['early','actor'])('rejects a directly forged server expiry: %s',async kind=>{
 const f=await prepared(),taskId=f.tasks[0]!,subject=String(f.db.prepare('SELECT reviewer_subject_id FROM governed_review_tasks WHERE id=?').get(taskId)!.reviewer_subject_id);
 expect(()=>sqliteCommand(f.db,c=>{
  const actor=kind==='actor'?subject:null,role=kind==='actor'?'owner':null,basis=taskEventContent({actorRoleAtReview:role,actorSubjectId:actor,eventKind:'expired',labelId:null,reason:'fixed_stop',taskId,sequence:1,previousEventDigest:null});
  c.db.prepare('INSERT INTO governed_review_task_events(id,project_id,task_id,sequence,state_version,expected_previous_state_version,event_kind,actor_subject_id,actor_role_at_review,reason,event_digest,idempotency_key,request_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('forged-expiry',f.projectId,taskId,1,1,0,'expired',actor,role,'fixed_stop',governedContentV1Digest('governed-review-task-event/v1',basis),'forged-expiry','sha256:'+'0'.repeat(64),c.timestamp);
 },kind==='actor'?()=>Date.parse(f.input.fixedStopAt):Date.now)).toThrow(/expiry|expiration|expired|exact reviewer snapshot/);
 expect(f.db.prepare("SELECT * FROM governed_review_task_events WHERE event_kind='expired'").all()).toEqual([]);
});
it.each(['resolved','incomplete'])('rejects direct invalid batch %s despite a valid event digest',async target=>{
 const f=await prepared(),taskId=f.tasks[0]!;
 if(target==='incomplete'){
  const view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);action(f.db,f.actor,taskId,{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[]}});
 }
 transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'},()=>Date.parse(f.input.fixedStopAt));
 const spy=interceptSqliteInsert(f.db,'governed_review_batch_events',row=>{
  row.event_kind=target;row.event_digest=governedContentV1Digest('governed-review-batch-event/v1',{actorRoleAtReview:row.actor_role_at_review,actorSubjectId:row.actor_subject_id,batchId:row.batch_id,datasetRevisionId:row.dataset_revision_id??null,details:JSON.parse(String(row.details)),eventKind:target,previousEventDigest:row.previous_event_digest,representativeIneligibleReasons:JSON.parse(String(row.representative_ineligible_reasons)),representativeOfPopulationId:row.representative_of_population_id??null,sequence:row.sequence,stateVersion:row.state_version});return row;
 });
 try{expect(()=>transition(f.db,f.actor,f.batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'invalid'})).toThrow(target==='resolved'?/complete resolved truth/:/coverage gap or unresolvable/);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('labeling_closed');
});
it('rejects a direct task mutation after the labeling barrier',async()=>{
 const f=await prepared(),taskId=f.tasks[0]!,view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId),label=action(f.db,f.actor,taskId,{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[]}});
 transition(f.db,f.actor,f.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 const previous=f.db.prepare('SELECT * FROM governed_review_task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(taskId)!;
 expect(()=>sqliteCommand(f.db,c=>{
  const basis=taskEventContent({actorRoleAtReview:String(previous.actor_role_at_review),actorSubjectId:String(previous.actor_subject_id),eventKind:'label_withdrawn',labelId:label.activeLabelId!,reason:'Late',taskId,sequence:3,previousEventDigest:String(previous.event_digest)});
  c.db.prepare('INSERT INTO governed_review_task_events(id,project_id,task_id,sequence,state_version,expected_previous_state_version,event_kind,actor_subject_id,actor_role_at_review,label_id,reason,previous_event_digest,event_digest,idempotency_key,request_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('late',f.projectId,taskId,3,3,2,'label_withdrawn',previous.actor_subject_id!,previous.actor_role_at_review!,label.activeLabelId!,'Late',previous.event_digest!,governedContentV1Digest('governed-review-task-event/v1',basis),'late','sha256:'+'0'.repeat(64),c.timestamp);
 })).toThrow(/open batch|labeling.*closed|requires open/);
});
