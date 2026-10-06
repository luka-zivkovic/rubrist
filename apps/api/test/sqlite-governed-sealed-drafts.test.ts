import { expect,it } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { governedSealedDraftFixture as prepared } from './helpers/sqlite-governed-sealed-draft.js';
import { createGovernedSealedIntake } from '../src/storage/sqlite/governed-sealed-intake-commands.js';
import { createGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch } from '../src/storage/sqlite/governed-view-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { CreateGovernedReviewBatchInputSchema } from '../src/governed-review/contracts.js';
it('binds a sealed draft to the exact protected frame and assigns independent reviewers',async()=>{
 const f=await prepared(),id=createGovernedDraft(f.db,f.actor,f.input),batch=f.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(id)!;
 expect(batch).toMatchObject({source_population_kind:'sealed_intake',population_id:f.intake.intakeId,population_digest:f.intake.frameDigest,population_size:2,required_labels_per_item:2,separation_of_duties_required:1,window_start:'2026-01-01T00:00:00+00:00'});
 const tasks=f.db.prepare('SELECT * FROM governed_review_tasks WHERE batch_id=?').all(id);expect(tasks).toHaveLength(2);expect(tasks.every(t=>t.reviewer_subject_id!==batch.custodian_subject_id)).toBe(true);
 expect(createGovernedDraft(f.db,f.actor,f.input)).toBe(id);expect(()=>createGovernedDraft(f.db,f.actor,{...f.input,selection:{method:'simple_random',fixedBudget:2}})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>transitionNonsealedGovernedBatch(f.db,f.actor,id,'open',{expectedStateVersion:0,idempotencyKey:'open'})).toThrow(expect.objectContaining({code:'sealed_separation_ineligible'}));
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('accepts client-item aliases for directed sealed selection without revealing intake payload',async()=>{
 const f=await prepared(),id=createGovernedDraft(f.db,f.actor,{...f.input,selection:{method:'manual',selectedSourceItemIds:['two']}});
 expect(f.db.prepare('SELECT i.sealed_frame_position FROM governed_review_batch_items b JOIN governed_review_items i ON i.id=b.review_item_id WHERE b.batch_id=?').get(id)?.sealed_frame_position).toBe(1);
});
it('rolls back drafts assigning the custodian or a missing project member as reviewer',async()=>{
 const f=await prepared();expect(()=>createGovernedDraft(f.db,f.actor,{...f.input,reviewerUserIds:[f.userId,f.reviewers[0]!]})).toThrow(/reviewer/);
 expect(()=>createGovernedDraft(f.db,f.actor,{...f.input,reviewerUserIds:['foreign',f.reviewers[0]!]})).toThrow();expect(f.db.prepare('SELECT * FROM governed_review_batches').all()).toEqual([]);
});
it.each(['digest','custodian','window','definition'])('rejects forged sealed source %s before finalization',async fault=>{
 const f=await prepared(),id=createGovernedDraft(f.db,f.actor,f.input),original=f.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(id)!;
 expect(()=>sqliteCommand(f.db,c=>{const row:Record<string,SQLInputValue>={...original,id:'forged',idempotency_key:'forged',created_at:c.timestamp,created_command_token:c.token};
 if(fault==='digest')row.population_digest='sha256:'+'a'.repeat(64);if(fault==='custodian')row.custodian_subject_id='foreign';if(fault==='window')row.window_start=null;if(fault==='definition')row.population_definition='{}';
 c.db.prepare(`INSERT INTO governed_review_batches(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));})).toThrow(/exact finalized protected intake/);
});
