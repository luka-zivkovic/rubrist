import { expect,it } from 'vitest';
import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import { governedConflictFixture } from './helpers/sqlite-governed-conflict.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { transitionNonsealedGovernedBatch as transition } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedAlignment as append } from '../src/storage/sqlite/governed-alignment-commands.js';
import { sqliteGovernedInstructionCommands } from '../src/storage/sqlite/governed-instruction-commands.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
const comment={expectedAlignmentVersion:0,kind:'comment_recorded' as const,content:'Discuss the ambiguity.',idempotencyKey:'comment'};
it('freezes exact visible labels, supports peer replay, and requires alignment closure before adjudication',async()=>{
 const f=await governedConflictFixture();expect(()=>append(f.db,f.actor,f.batchId,comment)).toThrow();
 transition(f.db,f.actor,f.batchId,'open_alignment',{expectedStateVersion:2,idempotencyKey:'alignment'});
 const first=append(f.db,f.actor,f.batchId,comment);expect(first).toMatchObject({sequence:1,visibleLabelCount:1});
 expect(f.db.prepare('SELECT label_id FROM governed_review_alignment_event_labels WHERE alignment_event_id=?').all(first.alignmentEventId)).toEqual([{label_id:f.labelId}]);
 const peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);expect(append(peer,f.actor,f.batchId,comment)).toEqual(first);
 expect(()=>append(peer,f.actor,f.batchId,{...comment,content:'Changed'})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>append(peer,f.actor,f.batchId,{...comment,idempotencyKey:'stale'})).toThrow(expect.objectContaining({code:'governed_review_stream_conflict'}));
 expect(()=>transition(peer,f.actor,f.batchId,'start_adjudication',{expectedStateVersion:3,idempotencyKey:'early'})).toThrow(/alignment must close/);
 append(peer,f.actor,f.batchId,{...comment,expectedAlignmentVersion:1,kind:'closed',idempotencyKey:'close-alignment'});
 expect(()=>append(peer,f.actor,f.batchId,{...comment,expectedAlignmentVersion:2,idempotencyKey:'late'})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 transition(peer,f.actor,f.batchId,'start_adjudication',{expectedStateVersion:3,idempotencyKey:'adjudicate'});
 expect(peer.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('adjudicating');
 expect(()=>peer.exec("UPDATE governed_review_alignment_events SET content='rewrite'")).toThrow(/immutable/);
 expect(peer.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(peer.prepare('SELECT * FROM governed_review_alignment_event_labels').all()).toEqual([]);
});
it('permits only later instruction proposals for the pinned criterion without changing the original instruction',async()=>{
 const f=await governedConflictFixture();transition(f.db,f.actor,f.batchId,'open_alignment',{expectedStateVersion:2,idempotencyKey:'alignment'});
 const successor=sqliteGovernedInstructionCommands(f.db).governedInstructionCreate(f.actor,{criterionVersionId:f.criterionVersionId,predecessorInstructionVersionId:f.input.instructionVersionId,title:'Clarified',instructions:'Clarify ambiguous evidence',failureCodeGuidance:'',idempotencyKey:'successor'});
 expect(()=>append(f.db,f.actor,f.batchId,{...comment,kind:'instruction_change_proposed',proposedInstructionVersionId:f.input.instructionVersionId})).toThrow(/later same-criterion/);
 append(f.db,f.actor,f.batchId,{...comment,kind:'instruction_change_proposed',proposedInstructionVersionId:successor.instructionVersionId});
 expect(f.db.prepare('SELECT instruction_version_id FROM governed_review_batches WHERE id=?').get(f.batchId)?.instruction_version_id).toBe(f.input.instructionVersionId);
});
it.each(['count','set','digest','actor','sequence'])('rejects forged alignment %s and rolls back the complete snapshot',async fault=>{
 const f=await governedConflictFixture();transition(f.db,f.actor,f.batchId,'open_alignment',{expectedStateVersion:2,idempotencyKey:'alignment'});
 const first=append(f.db,f.actor,f.batchId,comment),original=f.db.prepare('SELECT * FROM governed_review_alignment_events WHERE id=?').get(first.alignmentEventId)!;
 expect(()=>sqliteCommand(f.db,c=>{
  const row:Record<string,SQLInputValue>={...original,id:'forged',sequence:2,expected_previous_sequence:1,previous_event_digest:original.event_digest!,idempotency_key:'forged',occurred_at:c.timestamp,created_command_token:c.token};
  if(fault==='count')row.visible_label_count=2;if(fault==='set')row.visible_label_set_digest='sha256:'+'0'.repeat(64);if(fault==='actor')row.actor_subject_id='foreign';if(fault==='sequence')row.expected_previous_sequence=0;
  row.event_digest=governedContentV1Digest('governed-review-alignment-event/v1',{actorRoleAtReview:row.actor_role_at_review,actorSubjectId:row.actor_subject_id,batchId:f.batchId,content:row.content,eventKind:row.event_kind,previousEventDigest:row.previous_event_digest,proposedInstructionVersionId:row.proposed_instruction_version_id,sequence:row.sequence,visibleLabelCount:row.visible_label_count,visibleLabelSetDigest:row.visible_label_set_digest});
  if(fault==='digest')row.event_digest='sha256:'+'0'.repeat(64);
  c.db.prepare(`INSERT INTO governed_review_alignment_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_review_alignment_events').get()?.n).toBe(1);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO governed_review_alignment_event_labels VALUES(?,?,?)').run(f.projectId,first.alignmentEventId,'missing'))).toThrow();
});
it('rolls back alignment evidence when the label snapshot fails',async()=>{
 const f=await governedConflictFixture();transition(f.db,f.actor,f.batchId,'open_alignment',{expectedStateVersion:2,idempotencyKey:'alignment'});
 f.db.exec("CREATE TRIGGER test_fail_snapshot BEFORE INSERT ON governed_review_alignment_event_labels BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END;");
 expect(()=>append(f.db,f.actor,f.batchId,comment)).toThrow(/injected snapshot failure/);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_alignment_events').get()?.n).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM governed_review_alignment_finalizations').get()?.n).toBe(0);
});
