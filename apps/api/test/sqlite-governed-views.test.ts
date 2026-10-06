import { expect,it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createNonsealedGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { openNonsealedGovernedBatch,getOrCreateNonsealedBlindView } from '../src/storage/sqlite/governed-view-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { taskEventContent } from '../src/governed-review/storage-values.js';
async function prepared(){const f=await governedDraftFixture(),batchId=createNonsealedGovernedDraft(f.db,f.actor,f.input),taskId=String(f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').get(batchId)!.id);return {...f,batchId,taskId};}
it('stores exact blind bytes with an unchanged base64 event digest and replays through a plain backup',async()=>{
 const f=await prepared();expect(()=>getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId)).toThrow();
 const eventId=openNonsealedGovernedBatch(f.db,f.actor,f.batchId,{expectedStateVersion:0,idempotencyKey:'open'});
 expect(openNonsealedGovernedBatch(f.db,f.actor,f.batchId,{expectedStateVersion:0,idempotencyKey:'open'})).toBe(eventId);
 const artifact=getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId),view=JSON.parse(Buffer.from(artifact.canonicalBytes).toString('utf8'));
 expect(view).toMatchObject({contract:'rubrist/governed-blind-task-view/v1',taskId:f.taskId,batchId:f.batchId,criterion:{criterionVersionId:f.criterionVersionId},payloadSnapshot:{input:expect.any(String),output:expect.any(String)}});
 expect(view.payloadSnapshot).not.toHaveProperty('metadata');expect(JSON.stringify(view)).not.toContain('sourceRevisionId');
 const event=f.db.prepare('SELECT * FROM governed_review_task_events WHERE task_id=?').get(f.taskId)!;
 expect(event.canonical_view_bytes).toBeInstanceOf(Uint8Array);expect(Buffer.from(event.canonical_view_bytes as Uint8Array)).toEqual(Buffer.from(artifact.canonicalBytes));
 expect(event.view_digest).toBe('sha256:'+createHash('sha256').update(artifact.canonicalBytes).digest('hex'));
 expect(event.event_digest).toBe(governedContentV1Digest('governed-review-task-event/v1',taskEventContent({actorRoleAtReview:String(event.actor_role_at_review),actorSubjectId:String(event.actor_subject_id),eventKind:'viewed',taskId:f.taskId,sequence:1,previousEventDigest:null,canonicalViewBytesBase64:Buffer.from(artifact.canonicalBytes).toString('base64'),viewDigest:artifact.viewDigest,viewContractVersion:'rubrist/governed-blind-task-view/v1',canonicalizationVersion:'rubrist-canonical-json/v1',exposureClass:'provenance',activity:'governed_review'})));
 expect(getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId)).toEqual(artifact);expect(f.db.prepare('SELECT count(*) n FROM governed_review_task_events').get()?.n).toBe(1);
 expect(()=>openNonsealedGovernedBatch(f.db,f.actor,f.batchId,{expectedStateVersion:0,idempotencyKey:'stale'})).toThrow(expect.objectContaining({code:'governed_review_stream_conflict'}));
 const plain=new DatabaseSync(f.path);cleanup.push(()=>plain.close());expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');plain.prepare('VACUUM INTO ?').run(f.path+'.backup');
 const backup=new DatabaseSync(f.path+'.backup');cleanup.push(()=>backup.close());expect(Buffer.from(backup.prepare('SELECT canonical_view_bytes FROM governed_review_task_events').get()!.canonical_view_bytes as Uint8Array)).toEqual(Buffer.from(artifact.canonicalBytes));
 expect(()=>f.db.exec("UPDATE governed_review_task_events SET reason='rewrite'")).toThrow(/immutable/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM governed_review_task_events').all()).toEqual([]);
});
it.each(['payload','digest','actor','contract','version'])('rejects forged first-view %s before committing bytes',async fault=>{
 const f=await prepared();openNonsealedGovernedBatch(f.db,f.actor,f.batchId,{expectedStateVersion:0,idempotencyKey:'open'});
 const artifact=getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId),original=f.db.prepare('SELECT * FROM governed_review_task_events WHERE task_id=?').get(f.taskId)!;
 const sourceId=String(f.db.prepare('SELECT i.source_revision_item_id FROM governed_review_tasks t JOIN governed_review_batch_items b ON b.id=t.batch_item_id JOIN governed_review_items i ON i.id=b.review_item_id WHERE t.id=?').get(f.taskId)!.source_revision_item_id);
 const secondId=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,selection:{method:'manual',selectedSourceItemIds:[sourceId]},idempotencyKey:'second'}),taskId=String(f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').get(secondId)!.id);
 openNonsealedGovernedBatch(f.db,f.actor,secondId,{expectedStateVersion:0,idempotencyKey:'open'});
 expect(()=>sqliteCommand(f.db,c=>{
  const row: Record<string, SQLInputValue>={...original,id:'forged',task_id:taskId,occurred_at:c.timestamp};
  const view=JSON.parse(Buffer.from(artifact.canonicalBytes).toString('utf8'));view.taskId=taskId;view.batchId=secondId;
  // The original canonical bytes carry their first batch's task. Even a valid
  // payload hash and rehashed event must not permit substituting that artifact.
  row.canonical_view_bytes=fault==='payload'?Buffer.from(artifact.canonicalBytes):Buffer.from(JSON.stringify(view));
  row.view_digest='sha256:'+createHash('sha256').update(row.canonical_view_bytes).digest('hex');
  if(fault==='digest')row.view_digest='sha256:'+'0'.repeat(64);
  if(fault==='actor')row.actor_subject_id='foreign';
  if(fault==='contract')row.view_contract_version=null;
  if(fault==='version')row.expected_previous_state_version=9;
  row.event_digest=governedContentV1Digest('governed-review-task-event/v1',taskEventContent({actorRoleAtReview:String(row.actor_role_at_review),actorSubjectId:String(row.actor_subject_id),eventKind:'viewed',taskId,sequence:1,previousEventDigest:null,canonicalViewBytesBase64:Buffer.from(row.canonical_view_bytes as Uint8Array).toString('base64'),viewDigest:String(row.view_digest),viewContractVersion:row.view_contract_version===null?null:String(row.view_contract_version),canonicalizationVersion:String(row.canonicalization_version),exposureClass:'provenance',activity:'governed_review'}));
  c.db.prepare(`INSERT INTO governed_review_task_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_review_task_events WHERE task_id=?').get(taskId)?.n).toBe(0);
});
it('preserves defer/resume CAS and rejects task writes after abandonment while retaining exact prior views',async()=>{
 const f=await prepared();openNonsealedGovernedBatch(f.db,f.actor,f.batchId,{expectedStateVersion:0,idempotencyKey:'open'});
 const artifact=getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId);
 function action(kind:'deferred'|'resumed',expected:number){return sqliteCommand(f.db,c=>{
  const prior=c.db.prepare('SELECT * FROM governed_review_task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(f.taskId)!;
  const sequence=expected+1,reason=kind==='deferred'?'Needs later attention':null;
  const basis=taskEventContent({actorRoleAtReview:String(prior.actor_role_at_review),actorSubjectId:String(prior.actor_subject_id),eventKind:kind,taskId:f.taskId,sequence,previousEventDigest:String(prior.event_digest),reason});
  c.db.prepare('INSERT INTO governed_review_task_events(id,project_id,task_id,sequence,state_version,expected_previous_state_version,event_kind,actor_subject_id,actor_role_at_review,reason,previous_event_digest,event_digest,idempotency_key,request_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('action-'+sequence,f.projectId,f.taskId,sequence,sequence,expected,kind,prior.actor_subject_id!,prior.actor_role_at_review!,reason,prior.event_digest!,governedContentV1Digest('governed-review-task-event/v1',basis),'action-'+sequence,'sha256:'+'0'.repeat(64),c.timestamp);
 });}
 expect(()=>action('deferred',0)).toThrow(/version conflict/);action('deferred',1);
 expect(f.db.prepare('SELECT state,state_version FROM governed_review_task_states WHERE task_id=?').get(f.taskId)).toEqual({state:'deferred',state_version:2});
 expect(getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId)).toEqual(artifact);action('resumed',2);
 expect(f.db.prepare('SELECT state,state_version FROM governed_review_task_states WHERE task_id=?').get(f.taskId)).toEqual({state:'viewed',state_version:3});
 sqliteCommand(f.db,c=>{
  const prior=c.db.prepare('SELECT * FROM governed_review_batch_events WHERE batch_id=?').get(f.batchId)!;
  const basis={actorRoleAtReview:prior.actor_role_at_review,actorSubjectId:prior.actor_subject_id,batchId:f.batchId,datasetRevisionId:null,details:{},eventKind:'abandoned',previousEventDigest:prior.event_digest,representativeIneligibleReasons:[],representativeOfPopulationId:null,sequence:2,stateVersion:2};
  const row={...prior,id:'abandoned',sequence:2,state_version:2,expected_previous_state_version:1,event_kind:'abandoned',previous_event_digest:prior.event_digest!,event_digest:governedContentV1Digest('governed-review-batch-event/v1',basis),idempotency_key:'abandoned',occurred_at:c.timestamp};
  c.db.prepare(`INSERT INTO governed_review_batch_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 });
 expect(()=>action('deferred',3)).toThrow(/open batch/);expect(getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId)).toEqual(artifact);
 f.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.projectId,f.userId);
 expect(()=>getOrCreateNonsealedBlindView(f.db,f.actor,f.taskId)).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
});
