import { expect,it } from 'vitest';
import { CreateSkillVersionInputSchema } from '@rubrist/shared';
import { MOCK_BINDING,bindingInput } from './fixtures/execution-binding.js';
import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createNonsealedGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { appendGovernedCapabilityChecks as append,initializeGovernedCapabilityValidator as initialize } from '../src/storage/sqlite/governed-capability-commands.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
async function prepared(){
 const f=await governedDraftFixture(),batchId=createNonsealedGovernedDraft(f.db,f.actor,f.input);
 initialize(f.db);
 f.db.prepare('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,?,?)').run('independent',f.projectId,null,governedContentV1Digest('governed-reviewer-subject/v1',{projectId:f.projectId,subjectId:'independent'}),new Date().toISOString());
 const author=String(f.db.prepare('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?').get(f.projectId,f.userId)!.id);
 return {...f,batchId,author};
}
function basis(r:Record<string,SQLInputValue>){return {batchId:r.batch_id,capabilityQueryVersion:r.capability_query_version,checkScope:r.check_scope,coveredCapabilities:JSON.parse(String(r.covered_capabilities)),evidenceDigest:r.evidence_digest,evaluatorVersionId:r.evaluator_version_id,excludedCapabilities:JSON.parse(String(r.excluded_capabilities)),result:r.result,sequence:r.sequence,subjectId:r.subject_id,unknownCapabilities:JSON.parse(String(r.unknown_capabilities)),verificationMethod:r.verification_method};}
it('derives exact eligible and ineligible evidence, preserves replay, and rejects mutation',async()=>{
 const f=await prepared();expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',['independent'],'open'))).toBe('eligible');
 expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',[f.author],'open'))).toBe('ineligible');
 const rows=f.db.prepare('SELECT * FROM governed_review_capability_checks ORDER BY subject_id').all();expect(rows).toHaveLength(2);
 for(const row of rows){expect(row.content_digest).toBe(governedContentV1Digest('governed-review-capability-check/v1',basis(row)));expect(row.evidence_digest).toBe(governedContentV1Digest('sealed-separation-evidence/v1',JSON.parse(String(row.evidence))));}
 const author=rows.find(r=>r.subject_id===f.author)!;expect(JSON.parse(String(author.excluded_capabilities))).toEqual(['criterion_authoring','evaluator_authoring','instruction_authoring']);
 const peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);initialize(peer);
 expect(sqliteCommand(peer,c=>append(peer,c,f.batchId,'batch_open',['independent'],'open'))).toBe('eligible');expect(peer.prepare('SELECT count(*) n FROM governed_review_capability_checks').get()?.n).toBe(2);
 expect(()=>peer.exec("UPDATE governed_review_capability_checks SET result='eligible'")).toThrow(/immutable/);expect(()=>peer.exec('DELETE FROM governed_review_capability_checks')).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(peer.prepare('SELECT * FROM governed_review_capability_checks').all()).toEqual([]);
});
it('re-evaluates development exposure and appends changed facts under the same command key',async()=>{
 const f=await prepared();expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'truth_freeze',['independent'],'freeze'))).toBe('eligible');
 sqliteCommand(f.db,c=>c.db.prepare("INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'human_access','development','content_view','person',?,NULL,'dataset_revision',?,NULL,'{}',?,?)").run('exposed',f.projectId,f.revision.id,'independent',f.revision.id,'exposed',c.timestamp));
 expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'truth_freeze',['independent'],'freeze'))).toBe('ineligible');
 const rows=f.db.prepare('SELECT sequence,result,excluded_capabilities FROM governed_review_capability_checks ORDER BY sequence').all();expect(rows).toEqual([{sequence:1,result:'eligible',excluded_capabilities:'[]'},{sequence:2,result:'ineligible',excluded_capabilities:'["development_exposure"]'}]);
 expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'truth_freeze',['independent'],'freeze'))).toBe('ineligible');expect(f.db.prepare('SELECT count(*) n FROM governed_review_capability_checks').get()?.n).toBe(2);
});
it.each(['facts','evidence','digest','scope','criterion','sequence','coverage','bounds'])('rejects forged %s evidence inside a managed command',async fault=>{
 const f=await prepared();sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',['independent'],'open'));
 const original=f.db.prepare('SELECT * FROM governed_review_capability_checks').get()!;
 expect(()=>sqliteCommand(f.db,c=>{
  const row:Record<string,SQLInputValue>={...original,id:'forged',idempotency_key:'forged',sequence:2,expected_previous_sequence:1,checked_at:c.timestamp};
  if(fault==='facts'){row.subject_id=f.author;row.sequence=1;row.expected_previous_sequence=0;}
  if(fault==='evidence'){row.evidence='{}';row.evidence_digest=governedContentV1Digest('sealed-separation-evidence/v1',{});}
  if(fault==='scope')row.verification_method='independently_verified';if(fault==='criterion')row.criterion_version_id='foreign';if(fault==='sequence')row.sequence=3;if(fault==='coverage')row.covered_capabilities='[]';if(fault==='bounds')row.excluded_capabilities=JSON.stringify(['x'.repeat(1025)]);
  row.content_digest=governedContentV1Digest('governed-review-capability-check/v1',basis(row));if(fault==='digest')row.content_digest='sha256:'+'0'.repeat(64);
  c.db.prepare(`INSERT INTO governed_review_capability_checks(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_review_capability_checks').get()?.n).toBe(1);
});
it('rolls back all subjects if a later capability record fails',async()=>{
 const f=await prepared();f.db.exec("CREATE TRIGGER test_capability_failure BEFORE INSERT ON governed_review_capability_checks WHEN NEW.subject_id='independent' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
 expect(()=>sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',[f.author,'independent'],'open'))).toThrow(/injected failure/);expect(f.db.prepare('SELECT count(*) n FROM governed_review_capability_checks').get()?.n).toBe(0);
});

it('fails closed when a later evaluator version has unknown development authorship',async()=>{
 const f=await prepared();expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',['independent'],'open'))).toBe('eligible');
 const skillId=String(f.db.prepare('SELECT skill_id FROM skill_versions WHERE criterion_version_id=?').get(f.criterionVersionId)!.skill_id);
 const input=CreateSkillVersionInputSchema.parse({criterionVersionId:f.criterionVersionId,rubricMarkdown:'Historical rubric',prompt:'Evaluate',executionBinding:bindingInput(MOCK_BINDING),verdictKind:'binary'});
 await f.runtime.repository.createSkillVersionPending(skillId,input,{projectId:f.projectId});
 expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',['independent'],'open'))).toBe('unknown');
 expect(f.db.prepare('SELECT unknown_capabilities FROM governed_review_capability_checks ORDER BY sequence DESC LIMIT 1').get()?.unknown_capabilities).toBe('["evaluator_author_identity"]');
 expect(sqliteCommand(f.db,c=>append(f.db,c,f.batchId,'batch_open',['independent',f.author],'mixed'))).toBe('ineligible');
});
