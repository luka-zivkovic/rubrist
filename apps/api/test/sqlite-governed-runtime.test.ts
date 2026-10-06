import { expect,it } from 'vitest';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { governedSealedDraftFixture } from './helpers/sqlite-governed-sealed-draft.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createUnseededSqliteRuntime } from './helpers/sqlite.js';
import { GovernedReviewDomainError,GovernedReviewStreamConflictError } from '../src/governed-review/errors.js';
import { createApp } from '../src/app.js';
it('runs governed review through serialized workers, concurrent replay and restart',async()=>{
 const f=await governedDraftFixture(),peer=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>peer.close());const r=f.runtime.governedReview,p=peer.governedReview;
 const [a,b]=await Promise.all([r.createBatchDraft(f.actor,f.input),p.createBatchDraft(f.actor,f.input)]);expect(a).toEqual(b);const id=a.batchId;
 await r.transitionBatch(f.actor,id,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 await expect(p.transitionBatch(f.actor,id,'close_labeling',{expectedStateVersion:0,idempotencyKey:'stale'})).rejects.toBeInstanceOf(GovernedReviewStreamConflictError);
 await expect(p.transitionBatch(f.actor,id,'close_labeling',{expectedStateVersion:0,idempotencyKey:'stale'})).rejects.toMatchObject({code:'governed_review_stream_conflict',status:409,details:{currentState:'open',currentVersion:1}});
 const task=(await r.listReviewerTasks(f.actor))[0]!,[av,bv]=await Promise.all([r.getOrCreateBlindTaskView(f.actor,task.taskId),p.getOrCreateBlindTaskView(f.actor,task.taskId)]);expect(Buffer.from(av.canonicalBytes)).toEqual(Buffer.from(bv.canonicalBytes));
 await p.appendTaskAction(f.actor,task.taskId,{kind:'submit_label',input:{viewDigest:av.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 await r.transitionBatch(f.actor,id,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});expect((await p.getPostBarrierItemView(f.actor,id,a.items[0]!.batchItemId,'alignment')).resolution.resolvedLabel).toBe('pass');
 await r.transitionBatch(f.actor,id,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});const frozen=await p.transitionBatch(f.actor,id,'freeze',{expectedStateVersion:3,idempotencyKey:'freeze'});expect(frozen.evidenceClass).toBe('governed_blind');
 await peer.close();const restarted=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>restarted.close());expect(await restarted.governedReview.getBatchSummary(f.actor,id)).toEqual(frozen);expect(Buffer.from((await restarted.governedReview.getOrCreateBlindTaskView(f.actor,task.taskId)).canonicalBytes)).toEqual(Buffer.from(av.canonicalBytes));
});
it('serves session-only HTTP review routes and returns typed worker conflicts without SQL',async()=>{
 const f=await governedDraftFixture(),app=createApp(f.runtime.repository,{auth:f.runtime.auth,accounts:f.runtime.accounts,runtimeMode:'persistent',governedReviewRepository:f.runtime.governedReview});
 const login=await app.request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'synthetic-long-password'})});expect(login.status).toBe(200);
 const headers={cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'content-type':'application/json'},body=JSON.stringify(f.input);
 expect((await app.request('/api/governed-review/batches',{method:'POST',body,headers:{'content-type':'application/json'}})).status).toBe(401);
 const created=await app.request('/api/governed-review/batches',{method:'POST',body,headers});expect(created.status).toBe(201);expect(created.headers.get('cache-control')).toBe('private, no-store');
 const json=await created.json() as {batch:{batchId:string}};const id=json.batch.batchId;
 const conflict=await app.request(`/api/governed-review/batches/${id}/open`,{method:'POST',headers,body:JSON.stringify({expectedStateVersion:4,idempotencyKey:'stale'})});expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({code:'governed_review_stream_conflict',details:{currentState:'draft',currentVersion:0}});
 for(const suffix of ['/instructions','/subjects','/batches','/tasks',`/batches/${id}`])expect((await app.request('/api/governed-review'+suffix,{headers})).status).toBe(200);
});
it('preserves sealed separation error identity and maps overlap constraints across RPC',async()=>{
 const f=await governedSealedDraftFixture(),r=f.runtime.governedReview,batch=await r.createBatchDraft(f.actor,f.input);
 await expect(r.transitionBatch(f.actor,batch.batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'})).rejects.toBeInstanceOf(GovernedReviewDomainError);
 await expect(r.transitionBatch(f.actor,batch.batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'})).rejects.toMatchObject({code:'sealed_separation_ineligible',status:409});
 await expect(r.createSealedIntake(f.actor,{populationDefinition:'Overlap',items:[{clientItemId:'x',input:'Protected 1',output:'Changed'}],idempotencyKey:'overlap'})).rejects.toMatchObject({code:'sealed_overlap',status:409});
});
it('preserves the sealed_overlap contract for an exposed protected predecessor over RPC',async()=>{
 const f=await governedSealedDraftFixture(true),r=f.runtime.governedReview,batch=await r.createBatchDraft(f.actor,f.input);
 await r.transitionBatch(f.actor,batch.batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const userId of f.reviewers){const actor={...f.actor,userId,projectRole:'member' as const},task=(await r.listReviewerTasks(actor))[0]!,artifact=await r.getOrCreateBlindTaskView(actor,task.taskId);await r.appendTaskAction(actor,task.taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});}
 await r.transitionBatch(f.actor,batch.batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});await r.transitionBatch(f.actor,batch.batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 const frozen=await r.transitionBatch(f.actor,batch.batchId,'freeze',{expectedStateVersion:3,idempotencyKey:'freeze'}),revisionId=frozen.datasetRevisionId!;
 await f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId,actorUserId:f.userId});
 const item=JSON.parse(String(f.db.prepare('SELECT payload_snapshot FROM dataset_revision_items WHERE revision_id=?').get(revisionId)!.payload_snapshot));
 await expect(r.createSealedIntake(f.custodian,{populationDefinition:'Successor',predecessorRevisionId:revisionId,items:[{clientItemId:'next',...item}],idempotencyKey:'next'})).rejects.toMatchObject({code:'sealed_overlap',status:409});
});
