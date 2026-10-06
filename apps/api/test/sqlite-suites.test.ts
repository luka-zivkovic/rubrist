import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
import { EvaluatorSuiteBindingError, EvaluatorSuiteIdempotencyConflictError } from '../src/repository/errors.js';
import { canonicalEvaluatorSuiteManifestBytes } from '../src/lib/evaluator-suite-manifest.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-suite-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-suites-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const r=runtime.repository,criteria=[];
  for(const stableKey of ['grounded','brief'])criteria.push(await r.createCriterion(projectId,CreateCriterionInputSchema.parse({stableKey,name:stableKey,definition:`Be ${stableKey}.`,evaluator:{rubricMarkdown:`Pass ${stableKey} answers.`,prompt:'Judge {{rubric_markdown}}.',executionBinding:bindingInput(MOCK_BINDING)}}),{}));
  const members=criteria.map(value=>({criterionVersionId:value.versions[0]!.id,skillVersionId:value.evaluator.currentVersion.id}));
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  return {path,runtime,r,projectId,criteria,members,db};
}
describe('SQLite suites and comparison bindings',()=>{
  it('stores complete canonical suite BLOBs, serializes idempotency and rejects substitutions',async()=> {
    const f=await fixture(),input={idempotencyKey:'one',members:f.members,trialPlan:null};
    const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
    const values=await Promise.all([f.r.createEvaluatorSuiteManifest(f.projectId,input,{}),peer.repository.createEvaluatorSuiteManifest(f.projectId,input,{})]);
    expect(values[0]).toEqual(values[1]);const manifest=values[0]!;
    const stored=f.db.prepare('SELECT * FROM evaluator_suite_manifests').get()!;expect(Buffer.from(stored.canonical_bytes as Uint8Array).equals(canonicalEvaluatorSuiteManifestBytes(manifest))).toBe(true);
    expect(await f.r.listEvaluatorSuites(f.projectId)).toHaveLength(1);
    await expect(f.r.createEvaluatorSuiteManifest(f.projectId,{...input,members:input.members.slice(0,1)},{})).rejects.toBeInstanceOf(EvaluatorSuiteIdempotencyConflictError);
    await expect(f.r.createEvaluatorSuiteManifest(f.projectId,{...input,idempotencyKey:'bad',members:[{...f.members[0]!,skillVersionId:f.members[1]!.skillVersionId}]},{})).rejects.toBeInstanceOf(EvaluatorSuiteBindingError);
    expect(()=>f.db.exec("UPDATE evaluator_suite_manifests SET canonical_bytes=x'00'")).toThrow(/immutable/);
    // Replay an otherwise valid INSERT in a rolled-back sandbox so its
    // original bundle/sequence remain valid; vary only idempotency metadata.
    for(const [column,value] of [['idempotency_key','   '],['idempotency_key',' key '],['idempotency_key','x'.repeat(201)],['request_digest','invalid'],['request_digest','sha256:'+'A'.repeat(64)]]) {
      f.db.exec('BEGIN IMMEDIATE');
      try {
        f.db.exec('DROP TRIGGER suite_manifest_no_delete');
        f.db.prepare('DELETE FROM evaluator_suite_manifests WHERE id=?').run(stored.id!);
        const candidate={...stored,[column!]:value!};
        expect(()=>f.db.prepare(`INSERT INTO evaluator_suite_manifests(${Object.keys(candidate).join(',')}) VALUES(${Object.keys(candidate).map(()=>'?').join(',')})`).run(...Object.values(candidate))).toThrow(/CHECK/);
      } finally { f.db.exec('ROLLBACK'); }
    }
    const next=await f.r.createEvaluatorSuiteManifest(f.projectId,{...input,suiteId:manifest.suiteId,idempotencyKey:'two'},{});expect(next.revision).toBe(2);
    expect((await f.r.getEvaluatorSuite(f.projectId,manifest.suiteId))?.id).toBe(manifest.suiteId);
    expect(await f.r.getEvaluatorSuite('other',manifest.suiteId)).toBeNull();
    expect((await f.r.listEvaluatorSuiteManifests(f.projectId,manifest.suiteId)).map(row=>row.manifestId)).toEqual([next.manifestId,manifest.manifestId]);
    await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
    expect(await restarted.repository.getEvaluatorSuiteManifest(f.projectId,manifest.manifestId)).toEqual(manifest);
    expect(await restarted.repository.getEvaluatorSuiteManifest('other',manifest.manifestId)).toBeNull();
    await restarted.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
    expect(f.db.prepare('SELECT count(*) n FROM evaluator_suite_manifests').get()?.n).toBe(0);
  }, 30_000); // Concurrent runtimes, rollback sandboxes and a restart: ~2.7s alone, over 5s under contention.
  it('pins both comparisons to their exact versions, collection and tenant',async()=> {
    const f=await fixture(),dataset=await f.r.createDataset({projectId:f.projectId,name:'Compare'}),versions=f.members.map(member=>member.skillVersionId);
    const a=await f.r.createEvalRun({projectId:f.projectId,datasetId:dataset.id,skillVersionId:versions[0]!,trigger:'manual',items:[]});
    const b=await f.r.createEvalRun({projectId:f.projectId,datasetId:dataset.id,skillVersionId:versions[1]!,trigger:'manual',items:[]});
    const input={projectId:f.projectId,datasetId:dataset.id,versionAId:versions[0]!,versionBId:versions[1]!,runAId:a.id,runBId:b.id};
    const comparison=await f.r.createRunComparison(input);expect(await f.r.getRunComparison(f.projectId,comparison.id)).toEqual(comparison);
    expect(await f.r.getRunComparison('other',comparison.id)).toBeNull();
    await expect(f.r.createRunComparison({...input,versionAId:versions[1]!})).rejects.toThrow(/binding/);
    await expect(f.r.listRunComparisons(f.projectId,{limit:-1})).rejects.toThrow(/limit/);
  });
});
