import { expect,it } from 'vitest';
import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import { governedConflictFixture } from './helpers/sqlite-governed-conflict.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { transitionNonsealedGovernedBatch as transition } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedAdjudication as append } from '../src/storage/sqlite/governed-adjudication-commands.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
const first={expectedHeadAdjudicationId:null,decision:'pass' as const,rationale:'Evidence supports this decision',basis:'Interpretation of criterion',idempotencyKey:'first'};
async function prepared(){const f=await governedConflictFixture();const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'adjudicator@example.test',password:'synthetic-long-password',name:'Adjudicator'}});f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('adjudicator-membership',f.projectId,user.id,'owner',new Date().toISOString());const adjudicator={...f.actor,userId:user.id};transition(f.db,f.actor,f.batchId,'start_adjudication',{expectedStateVersion:2,idempotencyKey:'adjudicate'});return {...f,adjudicator};}
it('retains exact label snapshots and immutable corrections with head CAS and peer replay',async()=>{
 const f=await prepared();expect(()=>append(f.db,f.actor,f.batchId,f.batchItemId,first)).toThrow(/independent of item raters/);
 const a=append(f.db,f.adjudicator,f.batchId,f.batchItemId,first);expect(a).toMatchObject({chainVersion:1,predecessorAdjudicationId:null,consideredLabelIds:[f.labelId],decision:'pass'});
 const peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);expect(append(peer,f.adjudicator,f.batchId,f.batchItemId,first)).toEqual(a);
 expect(()=>append(peer,f.adjudicator,f.batchId,f.batchItemId,{...first,rationale:'Changed'})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>append(peer,f.adjudicator,f.batchId,f.batchItemId,{...first,idempotencyKey:'stale'})).toThrow(expect.objectContaining({code:'governed_review_stream_conflict'}));
 expect(()=>append(peer,f.adjudicator,f.batchId,f.batchItemId,{...first,idempotencyKey:'missing-reason',expectedHeadAdjudicationId:a.adjudicationId})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 const b=append(peer,f.adjudicator,f.batchId,f.batchItemId,{...first,idempotencyKey:'correct',expectedHeadAdjudicationId:a.adjudicationId,correctionReason:'Rechecked source evidence',decision:'fail'});
 expect(b).toMatchObject({chainVersion:2,predecessorAdjudicationId:a.adjudicationId,consideredLabelIds:[f.labelId]});
 expect(peer.prepare('SELECT resolution_kind,resolved_label,adjudication_id FROM governed_review_item_resolutions WHERE batch_item_id=?').get(f.batchItemId)).toEqual({resolution_kind:'adjudicated',resolved_label:'fail',adjudication_id:b.adjudicationId});
 expect(append(peer,f.adjudicator,f.batchId,f.batchItemId,first)).toEqual(a);
 transition(peer,f.actor,f.batchId,'finalize',{expectedStateVersion:3,idempotencyKey:'resolve'});
 expect(()=>append(peer,f.adjudicator,f.batchId,f.batchItemId,{...first,idempotencyKey:'after-resolve',expectedHeadAdjudicationId:b.adjudicationId,correctionReason:'Late'})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
 expect(()=>peer.exec("UPDATE governed_review_adjudications SET rationale='rewrite'")).toThrow(/immutable/);
 expect(peer.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');expect(peer.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(peer.prepare('SELECT * FROM governed_review_adjudications').all()).toEqual([]);
});
it('maps an unresolvable adjudication to incomplete without inventing binary truth',async()=>{
 const f=await prepared();append(f.db,f.adjudicator,f.batchId,f.batchItemId,{...first,decision:'unresolvable'});
 expect(f.db.prepare('SELECT resolution_kind,resolved_label FROM governed_review_item_resolutions WHERE batch_item_id=?').get(f.batchItemId)).toEqual({resolution_kind:'unresolvable',resolved_label:null});
 transition(f.db,f.actor,f.batchId,'finalize',{expectedStateVersion:3,idempotencyKey:'incomplete'});expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('incomplete');
});
it.each(['digest','set','count','head','reason','actor'])('rejects forged adjudication %s through direct SQL',async fault=>{
 const f=await prepared(),a=append(f.db,f.adjudicator,f.batchId,f.batchItemId,first),original=f.db.prepare('SELECT * FROM governed_review_adjudications WHERE id=?').get(a.adjudicationId)!;
 expect(()=>sqliteCommand(f.db,c=>{
  const row:Record<string,SQLInputValue>={...original,id:'forged',chain_version:2,expected_previous_chain_version:1,supersedes_adjudication_id:a.adjudicationId,correction_reason:'Correction',idempotency_key:'forged',created_at:c.timestamp,created_command_token:c.token};
  if(fault==='set')row.considered_label_set_digest='sha256:'+'0'.repeat(64);if(fault==='count')row.considered_label_count=2;if(fault==='head')row.supersedes_adjudication_id=null;if(fault==='reason')row.correction_reason=null;if(fault==='actor')row.adjudicator_subject_id=String(f.db.prepare('SELECT reviewer_subject_id FROM governed_review_tasks WHERE id=?').get(f.taskId)!.reviewer_subject_id);
  row.content_digest=governedContentV1Digest('governed-review-adjudication/v1',{adjudicatorRoleAtReview:row.adjudicator_role_at_review,adjudicatorSubjectId:row.adjudicator_subject_id,basis:row.basis,batchId:f.batchId,batchItemId:f.batchItemId,chainVersion:row.chain_version,consideredLabelCount:row.considered_label_count,consideredLabelSetDigest:row.considered_label_set_digest,correctionReason:row.correction_reason,decision:row.decision,rationale:row.rationale,supersedesAdjudicationId:row.supersedes_adjudication_id});if(fault==='digest')row.content_digest='sha256:'+'0'.repeat(64);
  c.db.prepare(`INSERT INTO governed_review_adjudications(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_review_adjudications').get()?.n).toBe(1);
});
it('rolls back adjudication when its considered-label snapshot fails',async()=>{
 const f=await prepared();f.db.exec("CREATE TRIGGER test_fail_adjudication_snapshot BEFORE INSERT ON governed_review_adjudication_labels BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END;");
 expect(()=>append(f.db,f.adjudicator,f.batchId,f.batchItemId,first)).toThrow(/injected snapshot failure/);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_adjudications').get()?.n).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM governed_review_adjudication_finalizations').get()?.n).toBe(0);
});
