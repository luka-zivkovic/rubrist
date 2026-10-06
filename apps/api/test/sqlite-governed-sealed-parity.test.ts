import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateSqlite } from '@rubrist/db/sqlite';
import { governedSealedDraftFixture } from './helpers/sqlite-governed-sealed-draft.js';
import { createGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { createGovernedSealedIntake as create } from '../src/storage/sqlite/governed-sealed-intake-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as view } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { freezeNonsealedGovernedTruth as freeze } from '../src/storage/sqlite/governed-freeze-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { GovernedReviewIdempotencyConflictError } from '../src/governed-review/errors.js';
type Fixture=Awaited<ReturnType<typeof governedSealedDraftFixture>>;
const command={expectedStateVersion:3,idempotencyKey:'freeze'},migration='0067_governed_sealed_intake_parity.sql';
async function resolve(f:Fixture,input=f.input){
 const batchId=createGovernedDraft(f.db,f.actor,input);transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT t.id,s.account_user_id FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=? ORDER BY t.id').all(batchId)){
  const actor={...f.actor,userId:String(task.account_user_id),projectRole:'member' as const},taskId=String(task.id),artifact=view(f.db,actor,taskId);
  action(f.db,actor,taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Supported independently',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});return batchId;
}
async function protectedPredecessor(f:Fixture){
 const revisionId=freeze(f.db,f.actor,await resolve(f,{...f.input,selection:{method:'simple_random',fixedBudget:2}}),command);
 const items=f.db.prepare('SELECT payload_snapshot FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(revisionId).map((r,i)=>({clientItemId:'successor-'+i,...JSON.parse(String(r.payload_snapshot))}));
 expect(items).toHaveLength(2);return {revisionId,items};
}
const count=(f:Fixture,sql:string,...args:string[])=>Number(f.db.prepare(sql).get(...args)?.n);
it('rejects a second successor intake over disjoint items of one protected predecessor exactly as PostgreSQL does',async()=>{
 const f=await governedSealedDraftFixture(true),{revisionId,items}=await protectedPredecessor(f);
 const first={populationDefinition:'Successor A',predecessorRevisionId:revisionId,items:[items[0]!],idempotencyKey:'successor-a'},a=create(f.db,f.custodian,first);
 const claims=count(f,"SELECT count(*) n FROM governed_input_identity_claims WHERE usage_class='sealed'"),second={populationDefinition:'Successor B',predecessorRevisionId:revisionId,items:[items[1]!],idempotencyKey:'successor-b'};
 expect(()=>create(f.db,f.custodian,second)).toThrow(GovernedReviewIdempotencyConflictError);
 expect(()=>create(f.db,f.actor,{...second,idempotencyKey:'successor-b-owner'})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict',status:409}));
 await expect(f.runtime.governedReview.createSealedIntake(f.custodian,second)).rejects.toMatchObject({code:'governed_review_idempotency_conflict',status:409});
 expect(count(f,'SELECT count(*) n FROM governed_sealed_intake_populations WHERE predecessor_revision_id=?',revisionId)).toBe(1);
 expect(count(f,"SELECT count(*) n FROM governed_review_items WHERE idempotency_key LIKE 'successor-b%'")).toBe(0);
 expect(count(f,"SELECT count(*) n FROM governed_input_identity_claims WHERE usage_class='sealed'")).toBe(claims);
 expect(create(f.db,f.custodian,first)).toEqual(a);await expect(f.runtime.governedReview.createSealedIntake(f.custodian,first)).resolves.toEqual(a);
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('fails the forward migration closed and preserves evidence when a database already holds a sealed branch',async()=>{
 const f=await governedSealedDraftFixture(true),{revisionId,items}=await protectedPredecessor(f);
 create(f.db,f.custodian,{populationDefinition:'Successor A',predecessorRevisionId:revisionId,items:[items[0]!],idempotencyKey:'successor-a'});
 // Reconstruct the exact pre-0067 schema, then record a branch that 0051 allowed.
 const original=readFileSync(new URL('../../../packages/db/sqlite-migrations/0051_governed_sealed_intake.sql',import.meta.url),'utf8').match(/CREATE TRIGGER governed_sealed_population_insert [\s\S]*?\nEND;/)![0];
 f.db.exec(`DROP INDEX governed_sealed_intake_one_successor;DROP TRIGGER governed_sealed_population_insert;${original}`);f.db.prepare('DELETE FROM rubrist_sqlite_migrations WHERE id>=?').run(migration);
 create(f.db,f.custodian,{populationDefinition:'Successor B',predecessorRevisionId:revisionId,items:[items[1]!],idempotencyKey:'successor-b'});
 const snapshot=()=>({history:f.db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all(),schema:f.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='governed_sealed_intake_populations' ORDER BY type,name").all(),intakes:f.db.prepare('SELECT * FROM governed_sealed_intake_populations ORDER BY id').all(),items:f.db.prepare("SELECT * FROM governed_review_items WHERE source_kind='sealed_intake' ORDER BY id").all()});
 const before=snapshot();expect(before.intakes.filter(row=>row.predecessor_revision_id===revisionId)).toHaveLength(2);
 expect(()=>migrateSqlite(f.db)).toThrow(/UNIQUE constraint failed: governed_sealed_intake_populations\.predecessor_revision_id/);
 expect(snapshot()).toEqual(before);expect(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
});
it('lets a live member custodian run the full sealed flow through freeze and still rejects removed or foreign custodians',async()=>{
 const f=await governedSealedDraftFixture(true,'member');expect(f.custodian.projectRole).toBe('member');
 expect(f.db.prepare('SELECT pm.role FROM governed_sealed_intake_populations p JOIN governed_reviewer_subjects s ON s.id=p.custodian_subject_id JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE p.id=?').get(f.intake.intakeId)?.role).toBe('member');
 const batchId=await resolve(f),revisionId=freeze(f.db,f.actor,batchId,command);
 expect(f.db.prepare('SELECT role,source_kind,provenance_level FROM dataset_revisions WHERE id=?').get(revisionId)).toEqual({role:'sealed_validation',source_kind:'sealed_intake',provenance_level:'governed_blind'});
 expect(count(f,"SELECT count(*) n FROM governed_review_capability_checks WHERE batch_id=? AND check_scope='truth_freeze' AND result='eligible'",batchId)).toBe(3);
 const items=f.db.prepare('SELECT payload_snapshot FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(revisionId).map((r,i)=>({clientItemId:'next-'+i,...JSON.parse(String(r.payload_snapshot))}));
 await expect(f.runtime.governedReview.createSealedIntake(f.custodian,{populationDefinition:'Member successor',predecessorRevisionId:revisionId,items,idempotencyKey:'member-successor'})).resolves.toMatchObject({protection:'sealed',predecessorRevisionId:revisionId});
 const subject=String(f.db.prepare('SELECT custodian_subject_id FROM governed_sealed_intake_populations WHERE id=?').get(f.intake.intakeId)!.custodian_subject_id),forged=f.db.prepare('SELECT * FROM governed_sealed_intake_populations WHERE id=?').get(f.intake.intakeId)!;
 f.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.projectId,f.custodian.userId);
 expect(()=>create(f.db,f.custodian,{populationDefinition:'Removed',items:[{clientItemId:'gone',input:'Removed custodian input',output:'x'}],idempotencyKey:'removed'})).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'outsider@example.test',password:'synthetic-long-password',name:'Outsider'}});
 expect(()=>create(f.db,{...f.custodian,userId:user.id},{populationDefinition:'Foreign',items:[{clientItemId:'foreign',input:'Foreign custodian input',output:'x'}],idempotencyKey:'foreign'})).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 expect(()=>sqliteCommand(f.db,c=>{const row={...forged,id:'forged',idempotency_key:'forged',custodian_subject_id:subject,created_at:c.timestamp,created_command_token:c.token};c.db.prepare(`INSERT INTO governed_sealed_intake_populations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));})).toThrow(/live member custodian/);
 expect(count(f,"SELECT count(*) n FROM governed_sealed_intake_populations WHERE id='forged'")).toBe(0);
});
