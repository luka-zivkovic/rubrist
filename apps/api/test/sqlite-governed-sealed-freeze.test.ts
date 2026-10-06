import { expect,it } from 'vitest';
import { governedSealedDraftFixture } from './helpers/sqlite-governed-sealed-draft.js';
import { createGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { createGovernedSealedIntake } from '../src/storage/sqlite/governed-sealed-intake-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as view } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { freezeNonsealedGovernedTruth as freeze } from '../src/storage/sqlite/governed-freeze-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
type Fixture=Awaited<ReturnType<typeof governedSealedDraftFixture>>;
async function resolve(f:Fixture,input=f.input){
 const batchId=createGovernedDraft(f.db,f.actor,input);transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT t.id,s.account_user_id FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=? ORDER BY t.id').all(batchId)){
  const actor={...f.actor,userId:String(task.account_user_id),projectRole:'member' as const},taskId=String(task.id),artifact=view(f.db,actor,taskId);
  action(f.db,actor,taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Supported independently',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});return batchId;
}
const command={expectedStateVersion:3,idempotencyKey:'freeze'};
function successor(f:Fixture,revisionId:string,key:string){const items=f.db.prepare('SELECT payload_snapshot FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(revisionId).map((r,i)=>({clientItemId:'successor-'+i,...JSON.parse(String(r.payload_snapshot))}));return createGovernedSealedIntake(f.db,f.custodian,{populationDefinition:'Protected successor',predecessorRevisionId:revisionId,items,idempotencyKey:key});}
it('materializes exact sealed truth and creates only one protected direct successor',async()=>{
 const f=await governedSealedDraftFixture(true),batchId=await resolve(f),revisionId=freeze(f.db,f.actor,batchId,command);
 const revision=f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(revisionId)!;expect(revision).toMatchObject({role:'sealed_validation',source_kind:'sealed_intake',source_dataset_id:null,parent_revision_id:null,provenance_level:'governed_blind',revision_number:1,item_count:1});
 expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_links WHERE dataset_revision_id=?').get(revisionId)?.n).toBe(1);expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE batch_id=? AND check_scope='truth_freeze' AND result='eligible'").get(batchId)?.n).toBe(3);expect(freeze(f.db,f.actor,batchId,command)).toBe(revisionId);
 const a=successor(f,revisionId,'successor-a');expect(()=>successor(f,revisionId,'successor-b')).toThrow(/unrelated intake/);
 const nextBatch=await resolve(f,{...f.input,source:{kind:'sealed_intake',intakeId:a.intakeId},idempotencyKey:'next-draft'}),competingBatch=await resolve(f,{...f.input,source:{kind:'sealed_intake',intakeId:a.intakeId},idempotencyKey:'competing-draft'});
 const next=freeze(f.db,f.actor,nextBatch,command);expect(f.db.prepare('SELECT parent_revision_id,series_id,revision_number FROM dataset_revisions WHERE id=?').get(next)).toEqual({parent_revision_id:revisionId,series_id:revision.series_id,revision_number:2});
 expect(()=>freeze(f.db,f.actor,competingBatch,command)).toThrow(/sealed successor|UNIQUE/);expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(competingBatch)?.state).toBe('resolved');expect(()=>successor(f,revisionId,'late')).toThrow(/predecessor/);
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM governed_dataset_truth_links').all()).toEqual([]);
});
it('refuses a successor when its predecessor is exposed after successor intake',async()=>{
 const f=await governedSealedDraftFixture(true),batch=await resolve(f),revisionId=freeze(f.db,f.actor,batch,command),intake=successor(f,revisionId,'next'),next=await resolve(f,{...f.input,source:{kind:'sealed_intake',intakeId:intake.intakeId},idempotencyKey:'next-draft'});
 await f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId,actorUserId:f.userId});
 expect(()=>freeze(f.db,f.actor,next,command)).toThrow(/protected sealed predecessor/);expect(()=>successor(f,revisionId,'late')).toThrow(/predecessor/);
});
it('retains failed separation evidence and refuses truth after a reviewer enters development',async()=>{
 const f=await governedSealedDraftFixture(true),batch=await resolve(f);
 await f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId:f.revision.id,actorUserId:f.reviewers[0]!});
 expect(()=>freeze(f.db,f.actor,batch,command)).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));expect(f.db.prepare("SELECT count(*) n FROM dataset_revisions WHERE role='sealed_validation'").get()?.n).toBe(0);expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE check_scope='truth_freeze' AND result='ineligible'").get()?.n).toBe(1);
});
it('rolls back the entire sealed bundle if finalization fails',async()=>{
 const f=await governedSealedDraftFixture(true),batch=await resolve(f);f.db.exec("CREATE TRIGGER test_sealed_failure BEFORE INSERT ON dataset_revision_finalizations WHEN EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND role='sealed_validation') BEGIN SELECT RAISE(ABORT,'injected finalization failure'); END;");
 expect(()=>freeze(f.db,f.actor,batch,command)).toThrow(/injected finalization/);expect(f.db.prepare("SELECT count(*) n FROM dataset_revisions WHERE role='sealed_validation'").get()?.n).toBe(0);expect(f.db.prepare('SELECT * FROM governed_dataset_truth_links').all()).toEqual([]);expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(batch)?.state).toBe('resolved');
});
it('rejects a claimed sealed revision that omits the exact native bundle',async()=>{
 const f=await governedSealedDraftFixture(true),batch=await resolve(f),revisionId=freeze(f.db,f.actor,batch,command),original=f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(revisionId)!;
 expect(()=>sqliteCommand(f.db,c=>{const row={...original,id:'forged',series_id:'forged',idempotency_key:'forged',created_at:c.timestamp};c.db.prepare(`INSERT INTO dataset_revisions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));c.db.prepare('INSERT INTO dataset_revision_finalizations VALUES(?,?)').run('forged',f.projectId);})).toThrow();
});
