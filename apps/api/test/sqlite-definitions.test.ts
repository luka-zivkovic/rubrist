import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema, CreatedCriterionSchema } from '@rubrist/shared';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import { sqliteDefinitionCommands } from '../src/storage/sqlite/definition-commands.js';
import { CriterionStableKeyConflictError, AmbiguousProjectSkillError } from '../src/repository/errors.js';
import { criterionVersionDigest } from '../src/lib/criterion-digest.js';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';

const cleanup: Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-definitions-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-definitions-')); cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'), runtime=await createSqliteRuntime(path); cleanup.push(()=>runtime.close());
  const result=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'a-long-synthetic-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:result.user.id,email:result.user.email,owner:true});
  const input=CreateCriterionInputSchema.parse({stableKey:'grounded',name:'Grounded',definition:'Answers follow the provided evidence.',
    evaluator:{rubricMarkdown:'Pass answers supported by evidence. 😀',prompt:'Evaluate the answer.',executionBinding:bindingInput(MOCK_BINDING)}});
  return {path,runtime,projectId,input,actor:{actorUserId:result.user.id}};
}
describe('SQLite native evaluator definitions',()=>{
  it('persists a complete native definition and author subject, preserves exact binding through restart',async()=>{
    const f=await fixture(), r=f.runtime.repository;
    const created=await r.createCriterion(f.projectId,f.input,f.actor);
    expect(CreatedCriterionSchema.parse(created)).toEqual(created);
    expect(created.evaluator.currentVersion.status).toBe('draft');
    expect(created.evaluator.currentVersion.executionBinding).toEqual(MOCK_BINDING);
    const db=openSqlite(f.path); cleanup.push(()=>db.close());
    const authors=db.prepare('SELECT created_by_subject_id,developer_identity_status FROM skill_versions').get()!;
    expect(authors.developer_identity_status).toBe('recorded');
    expect(authors.created_by_subject_id).toBeTypeOf('string');
    expect(db.prepare('SELECT count(*) n FROM governed_reviewer_subjects').get()?.n).toBe(1);
    const revised=await r.createCriterionVersion(f.projectId,created.criterion.id,{name:'Grounded revised',definition:'A narrower definition.'},f.actor);
    expect(revised?.revision).toBe(2);
    expect((await r.getSkillVersion(f.projectId,created.evaluator.currentVersion.id))?.criterionVersionId).toBe(created.versions[0]!.id);
    await f.runtime.close(); const next=await createSqliteRuntime(f.path); cleanup.push(()=>next.close());
    expect(await next.repository.getSkillVersion(f.projectId,created.evaluator.currentVersion.id)).toEqual(created.evaluator.currentVersion);
    expect((await next.repository.getCurrentSkill(f.projectId)).id).toBe(created.evaluator.id);
    expect(await next.repository.getSkillVersion('other-project',created.evaluator.currentVersion.id)).toBeNull();
  });
  it('preserves domain errors across worker RPC and rolls back duplicate authoring',async()=>{
    const f=await fixture(), r=f.runtime.repository;
    await r.createCriterion(f.projectId,f.input,f.actor);
    await expect(r.createCriterion(f.projectId,f.input,f.actor)).rejects.toBeInstanceOf(CriterionStableKeyConflictError);
    expect(await r.listCriteria(f.projectId)).toHaveLength(1);
    await expect(r.listSkillVersions(f.projectId,'any',-1)).rejects.toThrow(/limit/);
    await r.createCriterion(f.projectId,{...f.input,stableKey:'second'},f.actor);
    await expect(r.getCurrentSkill(f.projectId)).rejects.toBeInstanceOf(AmbiguousProjectSkillError);
  });
  it('authorizes legacy native execution idempotently, denies cross-project and governed lineages',async()=>{
    const f=await fixture(), r=f.runtime.repository, created=await r.createCriterion(f.projectId,f.input,f.actor);
    const auth={projectId:f.projectId,skillVersionId:created.evaluator.currentVersion.id,context:'release_gate' as const,resourceKind:'eval_run_item',resourceId:'item',idempotencyKey:'one'};
    await r.authorizeSkillVersionExecution(auth); await r.authorizeSkillVersionExecution(auth);
    await expect(r.authorizeSkillVersionExecution({...auth,resourceId:'different'})).rejects.toThrow(/idempotency/);
    await expect(r.authorizeSkillVersionExecution({...auth,projectId:'other'})).rejects.toThrow();
    const db=openSqlite(f.path); cleanup.push(()=>db.close()); const commands=sqliteDefinitionCommands(db);
    expect(db.prepare('SELECT count(*) n FROM evaluator_execution_authorizations').get()?.n).toBe(1);
    // Incomplete governed bundles cannot enter the database during this slice.
    expect(()=>db.prepare("INSERT INTO criteria VALUES('governed',?,'governed','analysis_promotion',NULL,?)").run(f.projectId,new Date().toISOString())).toThrow(/governed/);
    expect(()=>commands.authorizeSkillVersionExecution({...auth,skillVersionId:'absent-governed-version',idempotencyKey:'governed'})).toThrow(/governed/);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });
  it('rejects forged digests and altered evaluator identity even through direct SQL',async()=>{
    const f=await fixture(), created=await f.runtime.repository.createCriterion(f.projectId,f.input,f.actor);
    const db=openSqlite(f.path); cleanup.push(()=>db.close()); sqliteDefinitionCommands(db);
    expect(()=>db.exec("UPDATE criterion_versions SET definition='changed'")).toThrow(/immutable/);
    expect(()=>db.exec("UPDATE skill_versions SET prompt='changed'")).toThrow(/immutable/);
    expect(()=>db.exec('UPDATE criteria SET created_by_user_id=NULL')).toThrow(/immutable/);
    expect(()=>db.exec('UPDATE criterion_versions SET created_by_user_id=NULL')).toThrow(/immutable/);
    expect(()=>db.exec("UPDATE skill_versions SET regression_dataset_revision_id='nonexistent',status='production'")).toThrow(/binding unavailable/);
    expect(()=>db.prepare("INSERT INTO criterion_versions VALUES('forged',?,?,2,'Fake','Fake definition','sha256:bad','native',NULL,?)").run(f.projectId,created.criterion.id,new Date().toISOString())).toThrow(/digest/);
    const plain=openSqlite(f.path); cleanup.push(()=>plain.close());
    expect(()=>plain.prepare("INSERT INTO criterion_versions VALUES('plain',?,?,2,'Fake','Fake definition','sha256:bad','native',NULL,?)").run(f.projectId,created.criterion.id,new Date().toISOString())).toThrow(/function/);
    expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(()=>db.exec('DELETE FROM criterion_versions')).toThrow(/erasure/);
    expect(()=>db.exec('DELETE FROM skill_versions')).toThrow(/erasure/);
    await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project',...f.actor});
    expect(db.prepare('SELECT count(*) n FROM skill_versions').get()?.n).toBe(0);
  });
});
