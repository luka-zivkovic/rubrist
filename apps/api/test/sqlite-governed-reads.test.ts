import { expect,it } from 'vitest';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { governedSealedDraftFixture } from './helpers/sqlite-governed-sealed-draft.js';
import { createGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as view } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { freezeNonsealedGovernedTruth as freeze } from '../src/storage/sqlite/governed-freeze-commands.js';
import { sqliteGovernedReadCommands } from '../src/storage/sqlite/governed-read-commands.js';
it('projects nonsealed batches and owned tasks without peer progress before the barrier',async()=>{
 const f=await governedDraftFixture(),read=sqliteGovernedReadCommands(f.db),batchId=createGovernedDraft(f.db,f.actor,f.input),draft=read.governedBatchSummary(f.actor,batchId);
 expect(draft).toMatchObject({state:'draft',stateVersion:0,completeness:null,datasetRevisionId:null,evidenceClass:null,representativeness:{status:'not_evaluated',populationId:null,reasons:[]}});expect(draft.items[0]).toMatchObject({resolutionKind:null,resolvedLabel:null});expect(read.governedReviewerTasks(f.actor)).toEqual([]);
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});const task=read.governedReviewerTasks(f.actor)[0]!;expect(task).toMatchObject({state:'assigned',stateVersion:0,activeLabelId:null});expect(()=>read.governedPostBarrierView(f.actor,batchId,draft.items[0]!.batchItemId,'alignment')).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 const artifact=view(f.db,f.actor,task.taskId);action(f.db,f.actor,task.taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Exact support',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 expect(read.governedBatchSummary(f.actor,batchId).completeness).toBeNull();transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 const detail=read.governedPostBarrierView(f.actor,batchId,draft.items[0]!.batchItemId,'alignment');expect(detail.activeLabels).toHaveLength(1);expect(detail.activeLabels[0]!.rationale).toBe('Exact support');expect(detail.payloadSnapshot).not.toHaveProperty('metadata');expect(detail.resolution).toEqual({kind:'single_rater',resolvedLabel:'pass',adjudicationId:null});
 expect(read.governedBatchSummary(f.actor,batchId)).toMatchObject({completeness:{totalTasks:1,submittedTasks:1,deferredTasks:0,expiredTasks:0,pendingTasks:0}});expect(read.governedBatchList(f.actor,{state:'open'})).toEqual([]);expect(read.governedBatchList(f.actor,{criterionVersionId:f.criterionVersionId})).toHaveLength(1);
 transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});const revisionId=freeze(f.db,f.actor,batchId,{expectedStateVersion:3,idempotencyKey:'freeze'});expect(read.governedBatchSummary(f.actor,batchId)).toMatchObject({state:'frozen',datasetRevisionId:revisionId,evidenceClass:'governed_blind',representativeness:{status:'eligible'}});
 f.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.projectId,f.userId);expect(()=>read.governedBatchSummary(f.actor,batchId)).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));expect(()=>read.governedReviewerTasks(f.actor)).toThrow();
});
it('hides sealed outcomes in summaries and rechecks qualified post-barrier reads',async()=>{
 const f=await governedSealedDraftFixture(true),read=sqliteGovernedReadCommands(f.db),batchId=createGovernedDraft(f.db,f.actor,f.input),itemId=read.governedBatchSummary(f.actor,batchId).items[0]!.batchItemId;
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const userId of f.reviewers){const actor={...f.actor,userId,projectRole:'member' as const},task=read.governedReviewerTasks(actor)[0]!,artifact=view(f.db,actor,task.taskId);expect(read.governedReviewerTasks(actor)).toHaveLength(1);action(f.db,actor,task.taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Protected support',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});}
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 const summary=read.governedBatchSummary(f.actor,batchId);expect(summary.items[0]).toMatchObject({resolutionKind:null,resolvedLabel:null});expect(JSON.stringify(summary)).not.toContain('Protected support');expect(()=>read.governedPostBarrierView(f.actor,batchId,itemId,'adjudication')).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));
 const detail=read.governedPostBarrierView(f.custodian,batchId,itemId,'adjudication');expect(detail.activeLabels).toHaveLength(2);expect(detail.resolution).toEqual({kind:'unanimous',resolvedLabel:'pass',adjudicationId:null});
 await f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId:f.revision.id,actorUserId:f.custodian.userId});expect(()=>read.governedPostBarrierView(f.custodian,batchId,itemId,'adjudication')).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));
});
it('does not accept a forged owner role for unassigned post-barrier access',async()=>{
 const f=await governedDraftFixture(),read=sqliteGovernedReadCommands(f.db),batchId=createGovernedDraft(f.db,f.actor,f.input);transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 const task=read.governedReviewerTasks(f.actor)[0]!,artifact=view(f.db,f.actor,task.taskId);action(f.db,f.actor,task.taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'outsider@example.test',password:'synthetic-long-password',name:'Member'}});f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('member',f.projectId,user.id,'member',new Date().toISOString());
 expect(()=>read.governedPostBarrierView({...f.actor,userId:user.id},batchId,read.governedBatchSummary(f.actor,batchId).items[0]!.batchItemId,'alignment')).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
});
