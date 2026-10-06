import { stableId } from '../src/governed-review/storage-values.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { expect,it } from 'vitest';
import { governedFixture as instructionFixture } from './helpers/sqlite-governed.js';
import { sqliteGovernedInstructionCommands } from '../src/storage/sqlite/governed-instruction-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedJsonTextDigest } from '../src/storage/sqlite/governed-json-text.js';

it('stores immutable exact instruction lineages with idempotent replay and live owner checks',async()=>{
 const f=await instructionFixture(),commands=sqliteGovernedInstructionCommands(f.db),input={criterionVersionId:f.criterionVersionId,title:'Review evidence',instructions:'Read independently. 😀',failureCodeGuidance:'Preserve authored strings',idempotencyKey:'first'};
 const first=commands.governedInstructionCreate(f.actor,input);expect(first.instructionVersionId).toBe(stableId('griv',f.projectId,input.idempotencyKey));expect(first.instructionDigest).toBe(governedContentV1Digest('review-instruction/v1',{allowedLabels:['pass','fail','cannot_determine'],criterionVersionId:input.criterionVersionId,failureCodeGuidance:input.failureCodeGuidance,id:first.instructionVersionId,instructions:input.instructions,predecessorInstructionVersionId:null,revision:1,title:input.title}));expect(first.revision).toBe(1);expect(commands.governedInstructionCreate(f.actor,input)).toEqual(first);
 const next=commands.governedInstructionCreate(f.actor,{...input,idempotencyKey:'second',predecessorInstructionVersionId:first.instructionVersionId,instructions:'Read the revised criterion independently.'});
 expect(next.revision).toBe(2);expect(commands.governedInstructions(f.actor,f.criterionVersionId)).toEqual([first,next]);
 expect(()=>commands.governedInstructionCreate(f.actor,{...input,title:'Changed'})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>commands.governedInstructionCreate({...f.actor,projectRole:'member'},input)).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 f.db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?").run(f.projectId,f.userId);
 expect(()=>commands.governedInstructionCreate(f.actor,input)).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 expect(()=>commands.governedInstructions({...f.actor,projectId:'foreign'})).toThrow();
 expect(()=>f.db.exec("UPDATE review_instruction_versions SET title='rewrite'")).toThrow(/immutable/);
 expect(()=>f.db.exec('DELETE FROM review_instruction_versions')).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM review_instruction_versions').all()).toEqual([]);
});
it.each(['digest','labels','revision','predecessor','subject','bytes'])('rejects forged instruction %s in direct SQL',async fault=>{
 const f=await instructionFixture(),commands=sqliteGovernedInstructionCommands(f.db);
 const first=commands.governedInstructionCreate(f.actor,{criterionVersionId:f.criterionVersionId,title:'Review',instructions:'Review independently',failureCodeGuidance:'',idempotencyKey:'first'});
 expect(()=>sqliteCommand(f.db,c=>{
  const row=c.db.prepare('SELECT * FROM review_instruction_versions WHERE id=?').get(first.instructionVersionId)!;
  row.id='forged';row.revision=2;row.predecessor_instruction_version_id=first.instructionVersionId;row.created_at=c.timestamp;
  if(fault==='labels')row.allowed_labels='["pass","fail"]';
  if(fault==='revision')row.revision=3;
  if(fault==='predecessor')row.predecessor_instruction_version_id='foreign';
  if(fault==='subject')row.created_by_subject_id='foreign';
  if(fault==='bytes')row.instructions='😀'.repeat(65537);
  row.content_digest=governedJsonTextDigest('review-instruction/v1',JSON.stringify({id:row.id,criterionVersionId:row.criterion_version_id,revision:row.revision,predecessorInstructionVersionId:row.predecessor_instruction_version_id,title:row.title,instructions:row.instructions,allowedLabels:JSON.parse(String(row.allowed_labels)),failureCodeGuidance:row.failure_code_guidance}));
  if(fault==='digest')row.content_digest='sha256:'+'0'.repeat(64);
  c.db.prepare(`INSERT INTO review_instruction_versions VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();
 expect(f.db.prepare('SELECT count(*) n FROM review_instruction_versions').get()?.n).toBe(1);
});
it('preserves the PostgreSQL governed identity and instruction digest vector',()=>{
 const id=stableId('griv','project-😀','request-1');
 expect(id).toBe('griv_3519f5d207c02c7e499a0ae5ddc252c1963f03f3e232224e');
 const basis={allowedLabels:['pass','fail','cannot_determine'],criterionVersionId:'criterion-1',failureCodeGuidance:'',id,instructions:'Read independently.',predecessorInstructionVersionId:null,revision:1,title:'Evidence'};
 const digest='sha256:884393758bf9046397c838028539f171f3ee02c133416b36e2409f87a991a759';
 expect(governedContentV1Digest('review-instruction/v1',basis)).toBe(digest);
 expect(governedJsonTextDigest('review-instruction/v1',JSON.stringify(basis))).toBe(digest);
});
