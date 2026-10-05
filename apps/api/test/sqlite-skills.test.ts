import { fork } from 'node:child_process';
import { once } from 'node:events';
import { MockJudgeProvider } from '@rubrist/audit/runtime';
import { processGateRunJob } from '../src/workers/gate.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema, CreateSkillVersionInputSchema } from '@rubrist/shared';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { createAuth } from '../src/lib/auth.js';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
const definition=CreateCriterionInputSchema.parse({stableKey:'grounded',name:'Grounded',definition:'Use evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge {{rubric_markdown}}.',executionBinding:bindingInput(MOCK_BINDING)}});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-review-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-reviews-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const r=runtime.repository,created=await r.createCriterion(projectId,definition,{}),versionId=created.evaluator.currentVersion.id,criterionVersionId=created.versions[0]!.id;
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  return {dir,path,runtime,r,projectId,user,versionId,criterionVersionId,db};
}


const edit=CreateSkillVersionInputSchema.parse({rubricMarkdown:'New rubric',prompt:'Judge {{rubric_markdown}}',executionBinding:bindingInput(MOCK_BINDING),verdictKind:'binary'});
it('serializes evaluator edits with immutable criterion and regression pins and durable author identity',async()=>{
 const f=await fixture(),skill=(await f.r.getSkillVersion(f.projectId,f.versionId))!.skillId;
 const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
 const versions=await Promise.all([f.r,peer.repository].map(r=>r.createSkillVersionPending(skill,edit,{projectId:f.projectId,actorUserId:f.user.id,rubricProvenance:'human-authored'})));
 expect(new Set(versions.map(v=>v.version)).size).toBe(2);expect(new Set(versions.map(v=>v.regressionDatasetRevisionId)).size).toBe(1);
 expect(versions[0]).toMatchObject({status:'calibrating',criterionVersionId:f.criterionVersionId,rubricProvenance:'human-authored'});
 expect((await f.r.getDatasetRevisionDetail(f.projectId,versions[0]!.regressionDatasetRevisionId!))?.role).toBe('regression_golden');
 expect(f.db.prepare('SELECT created_by_subject_id FROM skill_versions WHERE id=?').get(versions[0]!.id)?.created_by_subject_id).toBeTruthy();
 expect(()=>f.db.prepare('UPDATE skill_versions SET regression_dataset_revision_id=NULL WHERE id=?').run(versions[0]!.id)).toThrow(/immutable/);
 const definition=await f.r.createCriterionVersion(f.projectId,(await f.r.listCriteria(f.projectId))[0]!.id,{name:'Updated',definition:'Updated definition'},{});
 await expect(f.r.createSkillVersionPending(skill,edit,{projectId:f.projectId})).rejects.toThrow(/explicit criterionVersionId/);
 expect((await f.r.createSkillVersionPending(skill,{...edit,criterionVersionId:definition!.id},{projectId:f.projectId})).criterionVersionId).toBe(definition!.id);
 await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());expect(await restarted.repository.getSkillVersion(f.projectId,versions[0]!.id)).toEqual(versions[0]);
});
it('signs off once with atomic audit and refuses unavailable providers before persistence',async()=>{
 const f=await fixture(),skill=(await f.r.getSkillVersion(f.projectId,f.versionId))!.skillId;
 f.db.exec("CREATE TRIGGER reject_signoff BEFORE INSERT ON audit_logs WHEN NEW.action='skill_version.signoff' BEGIN SELECT RAISE(ABORT,'injected'); END");
 await expect(f.r.signOffSkillVersion(f.projectId,skill,f.versionId,{actorUserId:f.user.id})).rejects.toThrow(/injected/);
 expect((await f.r.getSkillVersion(f.projectId,f.versionId))?.status).toBe('draft');f.db.exec('DROP TRIGGER reject_signoff');
 expect((await f.r.signOffSkillVersion(f.projectId,skill,f.versionId,{actorUserId:f.user.id}))?.status).toBe('approved');
 await expect(f.r.signOffSkillVersion(f.projectId,skill,f.versionId,{})).rejects.toThrow(/sign/);
 expect(await f.r.signOffSkillVersion('other',skill,f.versionId,{})).toBeNull();
 const strict=await createSqliteRuntime(f.path,()=>{throw new Error('Provider refused');});cleanup.push(()=>strict.close());
 await expect(strict.repository.createSkillVersionPending(skill,edit,{projectId:f.projectId})).rejects.toThrow(/Provider refused/);
 expect(await f.r.listSkillVersions(f.projectId,skill)).toHaveLength(1);
});
it('replays onboarding atomically and rolls back pairing, credentials and snapshots on failure',async()=>{
 const f=await fixture(),skill=(await f.r.getSkillVersion(f.projectId,f.versionId))!.skillId;
 f.db.prepare('UPDATE skills SET is_starter=1 WHERE id=?').run(skill);
 const context={projectId:f.projectId,actorUserId:f.user.id,onboardingCriterion:{name:'First Check',definition:'First definition',idempotencyKey:'first',requestDigest:'sha256:'+ 'a'.repeat(64)}};
 const created=await f.r.createSkillVersionPending(skill,edit,context);expect(created.onboardingAssurance).toBe('starter_unvalidated');
 expect(await f.r.createSkillVersionPending(skill,edit,context)).toEqual(created);
 await expect(f.r.createSkillVersionPending(skill,edit,{...context,onboardingCriterion:{...context.onboardingCriterion,requestDigest:'sha256:'+ 'b'.repeat(64)}})).rejects.toThrow(/different/);
 await expect(f.r.createSkillVersionPending(skill,edit,{projectId:f.projectId,agentSetup:{skillName:'Paired',skillDescription:'Paired definition',pairingId:'missing',providerCredential:{provider:'openai',apiKey:'synthetic'}}})).rejects.toThrow(/no longer active/);
 expect(await f.r.listJudgeProviderKeys(f.projectId)).toEqual([]);
 expect(await f.r.listSkillVersions(f.projectId,skill)).toHaveLength(2);
});

it('allocates from insertion order despite tied timestamps and enforces the onboarding digest contract',async()=>{
 const f=await fixture(),source=f.db.prepare('SELECT * FROM skill_versions WHERE id=?').get(f.versionId)!;
 for(const [id,version] of [['zz-older','0.1.1'],['aa-newer','0.1.2']] as const) {
  const row={...source,id,version};f.db.prepare(`INSERT INTO skill_versions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 expect((await f.r.createSkillVersionPending(String(source.skill_id),edit,{projectId:f.projectId})).version).toBe('0.1.3');
 for(const digest of ['bad','sha256:'+ 'A'.repeat(64)]) {
  const row={...source,id:randomUUID(),version:randomUUID(),onboarding_idempotency_key:'key',onboarding_request_digest:digest};
  expect(()=>f.db.prepare(`INSERT INTO skill_versions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row))).toThrow(/invalid onboarding/);
 }
 f.db.prepare('UPDATE skills SET is_starter=1 WHERE id=?').run(String(source.skill_id));
 expect(await f.r.createSkillVersionPending(String(source.skill_id),edit,{projectId:f.projectId,onboardingCriterion:{name:'Check',definition:'Definition',idempotencyKey:'x'.repeat(240),requestDigest:'sha256:'+ 'a'.repeat(64)}})).toBeDefined();
});
it('rolls back late paired setup failure then atomically consumes the pairing and saves credentials',async()=>{
 const f=await fixture(),skill=(await f.r.getSkillVersion(f.projectId,f.versionId))!.skillId;
 f.db.prepare('UPDATE skills SET is_starter=1 WHERE id=?').run(skill);
 const pairing=await f.runtime.accounts.createAgentSetupPairing({projectId:f.projectId,createdByUserId:f.user.id});expect(await f.runtime.accounts.claimAgentSetupPairing(pairing.id)).toBe(true);
 const context={projectId:f.projectId,actorUserId:f.user.id,agentSetup:{skillName:'Paired',skillDescription:'Pair definition',pairingId:pairing.id,providerCredential:{provider:'openai' as const,apiKey:'synthetic-secret'}}};
 f.db.exec("CREATE TRIGGER reject_pairing_consumption BEFORE UPDATE OF consumed_at ON agent_setup_pairings WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected late setup failure'); END");
 await expect(f.r.createSkillVersionPending(skill,edit,context)).rejects.toThrow(/injected late/);
 expect(await f.r.listSkillVersions(f.projectId,skill)).toHaveLength(1);expect(await f.r.listJudgeProviderKeys(f.projectId)).toEqual([]);expect(f.db.prepare('SELECT count(*) n FROM dataset_revisions').get()?.n).toBe(0);
 expect(f.db.prepare('SELECT claimed_at,consumed_at FROM agent_setup_pairings WHERE id=?').get(pairing.id)).toMatchObject({claimed_at:expect.any(String),consumed_at:null});
 f.db.exec('DROP TRIGGER reject_pairing_consumption');
 await f.r.createSkillVersionPending(skill,edit,context);
 expect(await f.r.getJudgeProviderCredential(f.projectId,'openai')).toBe('synthetic-secret');
 expect(f.db.prepare('SELECT claimed_at,consumed_at FROM agent_setup_pairings WHERE id=?').get(pairing.id)).toMatchObject({claimed_at:null,consumed_at:expect.any(String)});
 await expect(f.r.createSkillVersionPending(skill,edit,context)).rejects.toThrow(/no longer active/);
});

async function pendingRegression(f:Awaited<ReturnType<typeof fixture>>,overrideReason?:string) {
 const trace=await f.r.importTrace(f.projectId,'manual',{input:'question',output:'answer',metadata:{}},{ingestionPurpose:'judge_api'});
 await f.r.recordJudgeRun({projectId:f.projectId,caseId:trace.caseId,skillVersionId:f.versionId,verdict:{label:'fail',score:0.1,confidence:0.9}});
 await f.r.promoteExceptionToGoldenSet({projectId:f.projectId,caseId:trace.caseId,skillVersionId:f.versionId,agreedLabel:'pass',reason:'Reviewed correction'});
 const version=await f.r.createSkillVersionPending((await f.r.getSkillVersion(f.projectId,f.versionId))!.skillId,edit,{projectId:f.projectId});
 return {projectId:f.projectId,skillVersionId:version.id,datasetRevisionId:version.regressionDatasetRevisionId!,overrideReason,timeScope:'new' as const};
}
it('runs one regression across overlapping deliveries and atomically retains its outcome and exposure',async()=>{
 const f=await fixture(),job=await pendingRegression(f);let calls=0;
 const factory=()=>Object.assign(new MockJudgeProvider(),{async judge(){calls++;await new Promise(resolve=>setTimeout(resolve,30));return {label:'pass' as const,score:1,confidence:1,reason:'Pass'};}});
 const a=await createSqliteRuntime(f.path,factory),b=await createSqliteRuntime(f.path,factory);cleanup.push(()=>a.close(),()=>b.close());
 const [first,second]=await Promise.all([a.repository.runRegressionGateForVersion(job),b.repository.runRegressionGateForVersion(job)]);
 expect(await f.r.listRegressionRunsForVersions(f.projectId,[job.skillVersionId])).toEqual([first.regressionRun]);
 expect(calls).toBe(1);expect(first).toEqual(second);expect(first.version.status).toBe('approved');expect(first.regressionRun).toMatchObject({status:'passed',compared:1});
 expect(f.db.prepare("SELECT count(*) n FROM dataset_exposure_events WHERE evidence_ref_kind='regression_run'").get()?.n).toBe(1);
 expect(f.db.prepare("SELECT count(*) n FROM evaluator_execution_authorizations WHERE execution_context='candidate_regression_evidence'").get()?.n).toBe(1);
 await a.repository.failRegressionGateForVersion(job,new Error('late'));expect(await a.repository.runRegressionGateForVersion(job)).toEqual(first);expect(calls).toBe(1);
 expect(()=>f.db.exec("UPDATE regression_runs SET status='blocked'")).toThrow(/immutable/);expect(()=>f.db.exec('DELETE FROM regression_runs')).toThrow(/erasure/);
 await f.r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('records blocked and overridden governance outcomes, and rolls back a failed exposure insert',async()=>{
 const f=await fixture(),job=await pendingRegression(f);
 const failing=await createSqliteRuntime(f.path,()=>Object.assign(new MockJudgeProvider(),{async judge(){return {label:'fail' as const,score:0,confidence:1,reason:'Fail'};}}));cleanup.push(()=>failing.close());
 const blocked=await failing.repository.runRegressionGateForVersion(job);expect(blocked.version.status).toBe('regressing');expect(blocked.regressionRun.status).toBe('blocked');
 const override=await pendingRegression(f,'Known limitation documented');
 f.db.exec("CREATE TRIGGER reject_regression_exposure BEFORE INSERT ON dataset_exposure_events WHEN NEW.evidence_ref_kind='regression_run' BEGIN SELECT RAISE(ABORT,'injected exposure'); END");
 await expect(failing.repository.runRegressionGateForVersion(override)).rejects.toThrow(/injected exposure/);
 expect(await f.r.getRegressionRunForVersion(f.projectId,override.skillVersionId)).toBeNull();expect((await f.r.getSkillVersion(f.projectId,override.skillVersionId))?.status).toBe('calibrating');
 f.db.exec('DROP TRIGGER reject_regression_exposure');const result=await failing.repository.runRegressionGateForVersion(override);expect(result.regressionRun.status).toBe('overridden');expect(result.version.status).toBe('approved');
 expect(await f.r.listAuditEntries(f.projectId,'skill_version',override.skillVersionId)).toHaveLength(1);
});
it('fences stale regression attempts and failure finalizers and rejects incorrect immutable pins',async()=>{
 const f=await fixture(),job=await pendingRegression(f),s=f.runtime.storage;
 await expect(s.command('claimRegressionAttempt',{...job,datasetRevisionId:'wrong'},'bad')).rejects.toThrow(/binding|match/);
 const first=await s.command('claimRegressionAttempt',job,'first');if(first.state!=='claimed')throw new Error('claim');
 const old={projectId:f.projectId,skillVersionId:job.skillVersionId,token:'first',epoch:first.epoch};
 expect(await s.command('touchRegressionAttempt',old,true)).toBe(true);
 expect(await s.command('failRegressionGate',job,'stale failure')).toBe(false);
 expect(()=>f.db.prepare("UPDATE skill_versions SET status='approved' WHERE id=?").run(job.skillVersionId)).toThrow(/requires regression/);
 f.db.prepare('UPDATE regression_gate_attempts SET lease_until=0 WHERE skill_version_id=?').run(job.skillVersionId);
 const second=await s.command('claimRegressionAttempt',job,'second');expect(second.state).toBe('claimed');expect(await s.command('touchRegressionAttempt',old,true)).toBe(false);
 expect(f.db.prepare('SELECT uncertain_epochs FROM regression_gate_attempts').get()?.uncertain_epochs).toBe(1);
 await s.command('releaseRegressionAttempt',old);expect(await s.command('failRegressionGate',job,'stale failure')).toBe(false);
 f.db.prepare('UPDATE regression_gate_attempts SET lease_until=0 WHERE skill_version_id=?').run(job.skillVersionId);
 await f.r.failRegressionGateForVersion(job,new Error('exhausted'));
 const result=await f.r.runRegressionGateForVersion(job);expect(result).toMatchObject({version:{status:'failed'},regressionRun:{status:'error',error:'exhausted'}});
 const send=vi.fn();await processGateRunJob(f.r,{...job,timeScope:'both'},{send} as never);expect(send).not.toHaveBeenCalled();
 expect(f.db.prepare("SELECT count(*) n FROM evaluator_execution_authorizations WHERE resource_kind='regression_backfill'").get()?.n).toBe(0);
 expect(await s.command('finishRegressionAttempt',old,job,{...result.regressionRun,id:'late',status:'passed',error:null})).toBe(false);
});

it('does not let an owned attempt finalize a different evaluator',async()=>{
 const f=await fixture(),firstJob=await pendingRegression(f),secondJob=await pendingRegression(f),s=f.runtime.storage;
 const claim=await s.command('claimRegressionAttempt',firstJob,'owner');if(claim.state!=='claimed')throw new Error('claim');
 await s.command('claimRegressionAttempt',secondJob,'other');
 const result={id:'wrong-owner',skillVersionId:secondJob.skillVersionId,datasetRevisionId:secondJob.datasetRevisionId,status:'passed' as const,compared:0,regressed:0,improved:0,flipped:0,goldenSetMissing:true,cases:[],error:null,createdAt:new Date().toISOString()};
 await expect(s.command('finishRegressionAttempt',{projectId:f.projectId,skillVersionId:firstJob.skillVersionId,token:'owner',epoch:claim.epoch},secondJob,result)).rejects.toThrow(/ownership mismatch/);
 expect(await f.r.getRegressionRunForVersion(f.projectId,secondJob.skillVersionId)).toBeNull();expect(f.db.prepare('SELECT token FROM regression_gate_attempts WHERE skill_version_id=?').get(secondJob.skillVersionId)?.token).toBe('other');
});

it.each(['dispatch','finalize'])('recovers a regression after SIGKILL at %s with one immutable outcome',async(phase)=>{
 const f=await fixture(),job=await pendingRegression(f);
 const child=fork(fileURLToPath(new URL('./fixtures/sqlite-interrupted-regression.ts',import.meta.url)),[f.path,JSON.stringify(job),phase],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
 cleanup.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 let errors='';child.stderr?.on('data',data=>{errors+=String(data);});
 const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(errors);})]);expect(ready).toEqual({phase});
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 expect(await f.r.getRegressionRunForVersion(f.projectId,job.skillVersionId)).toBeNull();
 f.db.prepare('UPDATE regression_gate_attempts SET lease_until=0 WHERE skill_version_id=?').run(job.skillVersionId);
 let calls=0;const restarted=await createSqliteRuntime(f.path,()=>Object.assign(new MockJudgeProvider(),{async judge(){calls++;return {label:'pass' as const,score:1,confidence:1};}}));cleanup.push(()=>restarted.close());
 const result=await restarted.repository.runRegressionGateForVersion(job);expect(result.regressionRun.status).toBe('passed');expect(calls).toBe(1);
 expect(await restarted.repository.runRegressionGateForVersion(job)).toEqual(result);expect(calls).toBe(1);
 expect(f.db.prepare('SELECT uncertain_epochs FROM regression_gate_attempts WHERE skill_version_id=?').get(job.skillVersionId)?.uncertain_epochs).toBe(1);
 expect(f.db.prepare('SELECT count(*) n FROM regression_runs WHERE skill_version_id=?').get(job.skillVersionId)?.n).toBe(1);
});

it('runs synchronous editing through the same retained regression and tenant checks',async()=>{
 const f=await fixture(),skill=(await f.r.getCurrentSkill(f.projectId)).id;
 const result=await f.r.createSkillVersion(skill,edit,{projectId:f.projectId});
 expect(result.version.status).toBe('approved');expect(result.regressionRun.goldenSetMissing).toBe(true);
 expect(await f.r.getRegressionRunForVersion(f.projectId,result.version.id)).toEqual(result.regressionRun);
 expect(await f.r.listRegressionRunsForVersions('other',[result.version.id])).toEqual([]);
});
