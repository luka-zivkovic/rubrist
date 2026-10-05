import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { capabilityCheckContext, CAPABILITY_CHECK_CARRY_MS, MemoryCapabilityCheckStore } from '../src/lib/capability-check-store.js';
import { EvaluatorCallError } from '@rubrist/audit/runtime';
import { resolveExecutionBinding, runCapabilityCheck } from '../src/lib/evaluator-resolution.js';
import { SEEDED_BINDING, bindingInput, resolvedRecordFor } from './fixtures/execution-binding.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-resolution-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-resolution-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const created=await runtime.repository.createCriterion(projectId,CreateCriterionInputSchema.parse({stableKey:'grounded',name:'Grounded',definition:'Use evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge {{rubric_markdown}}.',executionBinding:bindingInput(SEEDED_BINDING)}}),{});
  const versionId=created.evaluator.currentVersion.id,db=openSqlite(path);cleanup.push(()=>db.close());
  return {path,runtime,projectId,versionId,db};
}
describe('SQLite provider assistance and resolution storage',()=>{
  it('persists capability evidence with stable ordering, expiry and credential/project isolation',async()=> {
    const f=await fixture(),{provider,endpoint,modelId,modelVersion,outputTokenLimit,routing}=SEEDED_BINDING;
    const check=await runCapabilityCheck({base:{provider,endpoint,modelId,modelVersion,outputTokenLimit,routing},credentialSource:'project',published:null,documentedDefault:null,temperatureIgnored:false,execute:async()=>({usage:null})});
    const contextDigest=capabilityCheckContext(check,'private-test-key'),now=new Date('2026-09-29T10:00:00Z'),memory=new MemoryCapabilityCheckStore();
    // Equal timestamps must retain insertion order: a later full check resets
    // earlier classifications, exactly as the PostgreSQL sequence does.
    for(const [classification,value] of [[false,check],[true,{...check,probes:check.probes.slice(0,1)}],[false,{...check,probes:check.probes.slice(1)}]] as const) {
      const entry={projectId:f.projectId,contextDigest,checkedAt:now,classification,check:value};await f.runtime.capabilityChecks.put(entry);await memory.put(entry);
    }
    await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
    expect(await restarted.capabilityChecks.get(f.projectId,contextDigest,now,SEEDED_BINDING)).toEqual(await memory.get(f.projectId,contextDigest,now,SEEDED_BINDING));
    expect(await restarted.capabilityChecks.get('other',contextDigest,now,SEEDED_BINDING)).toBeNull();
    expect(await restarted.capabilityChecks.get(f.projectId,capabilityCheckContext(check,'rotated'),now,SEEDED_BINDING)).toBeNull();
    expect(await restarted.capabilityChecks.get(f.projectId,contextDigest,new Date(now.getTime()-1),SEEDED_BINDING)).toBeNull();
    expect(await restarted.capabilityChecks.get(f.projectId,contextDigest,new Date(now.getTime()+CAPABILITY_CHECK_CARRY_MS),SEEDED_BINDING)).toBeNull();
    expect(JSON.stringify(f.db.prepare('SELECT * FROM evaluator_capability_checks').all())).not.toContain('private-test-key');
    await restarted.capabilityChecks.put({projectId:f.projectId,contextDigest,checkedAt:new Date(now.getTime()+CAPABILITY_CHECK_CARRY_MS),classification:false,check});
    expect(f.db.prepare('SELECT count(*) n FROM evaluator_capability_checks').get()?.n).toBe(1);
    await restarted.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT count(*) n FROM evaluator_capability_checks').get()?.n).toBe(0);
  });
  it('atomically records attempts, keeps failure sticky across competing resolution and isolates exact bindings',async()=> {
    const f=await fixture(),record=await resolvedRecordFor(SEEDED_BINDING);
    const attempt={projectId:f.projectId,skillVersionId:f.versionId,executionBinding:SEEDED_BINDING,kind:'resolution' as const,triggerKind:'on_demand' as const,triggerRef:'synthetic',outcome:'resolved' as const,probes:record.probes};
    expect(await f.runtime.resolution.recordResolution(attempt,record)).toEqual(record);
    const failed=await resolveExecutionBinding({binding:SEEDED_BINDING,trigger:'gate',check:null,published:null,documentedDefault:null,credentialSource:'project',ignoredTemperature:null,execute:async()=>{throw new EvaluatorCallError('provider_rejected_request','Synthetic refusal',{physicalCall:true,status:400});},now:new Date('2026-09-26T00:00:00.000Z')});
    expect(failed.status).toBe('failed');
    await f.runtime.resolution.recordResolution({...attempt,outcome:'failed'},failed);
    const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
    expect(await peer.resolution.recordResolution(attempt,record)).toEqual(failed);
    const loaded=await peer.resolution.getGovernedBinding({projectId:f.projectId},f.versionId);expect(loaded?.record).toEqual(failed);expect(loaded?.binding.executionBinding).toEqual(SEEDED_BINDING);
    expect(await peer.resolution.getGovernedBinding({projectId:'other'},f.versionId)).toBeNull();
    await expect(peer.resolution.recordResolution({...attempt,projectId:'other'},record)).rejects.toThrow();
    expect(f.db.prepare('SELECT count(*) n FROM evaluator_resolution_attempts').get()?.n).toBe(3);
    expect(()=>f.db.exec("UPDATE evaluator_resolution_attempts SET outcome='unresolved'")).toThrow(/immutable/);
    expect(()=>f.db.exec('DELETE FROM evaluator_resolution_attempts')).toThrow(/erasure/);
    // A syntactically valid record for another binding is absent to readers.
    f.db.prepare('UPDATE evaluator_resolution_records SET binding_digest=?').run('sha256:'+'0'.repeat(64));
    expect((await peer.resolution.getGovernedBinding({projectId:f.projectId},f.versionId))?.record).toBeNull();
    expect(await peer.resolution.recordResolution({...attempt,triggerKind:'version_save'},record)).toEqual(record);
    // After-save partial resolution cannot overwrite a fuller current record.
    const later={...record,checkedAt:'2026-10-01T00:00:00.000Z'};
    expect(await peer.resolution.recordResolution({...attempt,triggerKind:'version_save'},later)).toEqual(record);
    // Invalid historical records read as absent and can be repaired.
    f.db.exec("UPDATE evaluator_resolution_records SET record='{\"status\":\"resolved\"}'");
    expect((await peer.resolution.getGovernedBinding({projectId:f.projectId},f.versionId))?.record).toBeNull();
    expect(await peer.resolution.recordResolution({...attempt,triggerKind:'version_save'},record)).toEqual(record);
    await peer.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
    expect(f.db.prepare('SELECT count(*) n FROM evaluator_resolution_attempts').get()?.n).toBe(0);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
