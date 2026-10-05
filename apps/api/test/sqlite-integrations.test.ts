import { PROVISIONAL_FEEDBACK_HOLD } from '../src/lib/provisional-feedback.js';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
import { MockJudgeProvider } from '@rubrist/audit/runtime';
import { registerEvalRunWorkers } from '../src/workers/eval-run.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { datasetInputIdentity } from '../src/lib/dataset-revision.js';
import { DatasetRevisionConflictError, SealedValidationUnavailableError } from '../src/repository/errors.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-revision-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-revisions-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const r=runtime.repository,dataset=await r.createDataset({projectId,name:'Examples'});
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  return {path,runtime,r,projectId,dataset,db,user};
}

async function evaluator(f:Awaited<ReturnType<typeof fixture>>,key='grounded') {
 return (await f.r.createCriterion(f.projectId,CreateCriterionInputSchema.parse({stableKey:key,name:'Grounded',definition:'Grounded answers',evaluator:{rubricMarkdown:'Grounded',prompt:'Judge',executionBinding:bindingInput(MOCK_BINDING)}}),{})).evaluator.currentVersion.id;
}
it('stores encrypted credentials, serializes polling and retains import identity through integration deletion',async()=>{
 const f=await fixture();
 const disconnected=await f.r.createLangSmithIntegration(f.projectId,{apiKey:'synthetic-secret',projectName:'remote',pollIntervalSeconds:60});expect(disconnected.skillVersionId).toBeNull();
 expect(await f.r.claimDueLangSmithImportTargets({now:new Date(),batchSize:5,defaultLimit:25,intervalMs:60_000})).toEqual([]);
 const version=await evaluator(f),integration=await f.r.createLangSmithIntegration(f.projectId,{apiKey:'synthetic-secret',projectName:'remote',pollIntervalSeconds:60,skillVersionId:version});expect(integration.id).toBe(disconnected.id);
 const stored=f.db.prepare('SELECT encrypted_credentials FROM integrations').get()!;expect(String(stored.encrypted_credentials)).not.toContain('synthetic-secret');expect(JSON.stringify(integration)).not.toContain('synthetic-secret');
 const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());const now=new Date();
 const claims=await Promise.all([f.r.claimDueLangSmithImportTargets({now,batchSize:5,defaultLimit:25,intervalMs:60_000}),peer.repository.claimDueLangSmithImportTargets({now,batchSize:5,defaultLimit:25,intervalMs:60_000})]);expect(claims.flat()).toHaveLength(1);expect(claims.flat()[0]?.skillVersionId).toBe(version);
 expect(await f.r.claimDueLangSmithImportTargets({now:new Date(now.getTime()+59_000),batchSize:5,defaultLimit:25,intervalMs:60_000})).toEqual([]);
 expect(await f.r.claimDueLangSmithImportTargets({now:new Date(now.getTime()+60_001),batchSize:5,defaultLimit:25,intervalMs:60_000})).toHaveLength(1);
 const job=await f.r.createImportJob({projectId:f.projectId,source:'langsmith',sourceIntegrationId:integration.id,skillVersionId:version,actorUserId:f.user.id,requestedLimit:5});
 expect(await f.r.loadLangSmithImportContext({projectId:f.projectId,integrationId:integration.id,skillVersionId:version,limit:5,importJobId:job.id})).toMatchObject({apiKey:'synthetic-secret',skillVersionId:version,projectName:'remote'});
 await f.r.markImportJobQueued(f.projectId,job.id,'queue-one');await f.r.markImportJobRunning(f.projectId,job.id);
 const context={ingestionPurpose:'analysis_eligible_langsmith' as const,sourceIntegrationId:integration.id,importJobId:job.id};
 const input={sourceTraceId:'remote-trace',input:'x',output:'y',metadata:{}};
 const first=await f.r.importTrace(f.projectId,'langsmith',input,context);expect((await f.r.importTrace(f.projectId,'langsmith',input,context)).created).toBe(false);
 await f.r.markImportJobCompleted(f.projectId,job.id,{queuedJudgeCount:1,importedCount:999});
 expect((await f.r.listImportJobs({projectId:f.projectId,limit:10}))[0]).toMatchObject({status:'completed',importedCount:1,queuedJudgeCount:1,actorEmail:f.user.email});
 await expect(f.r.loadLangSmithImportContext({projectId:'other',integrationId:integration.id,limit:5})).rejects.toThrow(/not found/);
 await expect(f.r.importTrace(f.projectId,'langfuse',input,{...context,ingestionPurpose:'analysis_eligible_langfuse'})).rejects.toThrow(/binding/);
 await f.r.deleteLangSmithIntegration(f.projectId,integration.id,{actorUserId:f.user.id});
 expect(await f.r.getCaseSourceIdentity(f.projectId,first.caseId)).toMatchObject({sourceIntegrationId:null,sourceTraceId:'remote-trace'});
 expect(await f.r.listAuditEntries(f.projectId,'integration',integration.id)).toHaveLength(1);
 expect((await f.r.listImportJobs({projectId:f.projectId,limit:10}))[0]?.sourceIntegrationId).toBeNull();
 await f.r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('retains Langfuse polling settings and records failed exact-version selection without ambiguous jobs',async()=>{
 const f=await fixture(),version=await evaluator(f);
 const integration=await f.r.createLangfuseIntegration(f.projectId,{publicKey:'public-synthetic',secretKey:'private-synthetic',endpointUrl:'https://langfuse.example.test',pollEnabled:false,skillVersionId:version});
 expect((await f.r.listLangfuseIntegrations(f.projectId))[0]?.pollEnabled).toBe(false);
 await f.r.updateLangfuseIntegration(f.projectId,integration.id,{pollEnabled:true,pollLimit:7});
 expect(await f.r.loadLangfuseImportContext({projectId:f.projectId,integrationId:integration.id,skillVersionId:version,limit:7})).toMatchObject({publicKey:'public-synthetic',secretKey:'private-synthetic',pollEnabled:true,pollLimit:7});
 f.db.prepare("UPDATE integrations SET config=json_set(config,'$.skillVersionId',NULL) WHERE id=?").run(integration.id);await evaluator(f,'other');
 expect(await f.r.claimDueLangfuseImportTargets({now:new Date(),batchSize:5,defaultLimit:25,intervalMs:60_000})).toEqual([]);
 expect((await f.r.listImportJobs({projectId:f.projectId,limit:10}))[0]).toMatchObject({status:'failed',skillVersionId:null,source:'langfuse'});
 await f.r.updateLangfuseIntegration(f.projectId,integration.id,{skillVersionId:version});
 const trace=await f.r.importTrace(f.projectId,'langfuse',{sourceTraceId:'lf-feedback',input:'x',output:'y',metadata:{}},{ingestionPurpose:'analysis_eligible_langfuse',sourceIntegrationId:integration.id});
 const judged=await f.r.recordJudgeRun({projectId:f.projectId,caseId:trace.caseId,skillVersionId:version,verdict:{label:'pass',score:0.9,confidence:0.9}});
 const feedback=await f.r.createFeedbackSyncJob({projectId:f.projectId,judgeRunId:judged.id,provider:'langfuse'});
 expect(await f.r.loadFeedbackSyncContext({projectId:f.projectId,feedbackSyncJobId:feedback!.id})).toMatchObject({integration:{provider:'langfuse',publicKey:'public-synthetic',secretKey:'private-synthetic'}});

 await f.r.deleteLangfuseIntegration(f.projectId,integration.id,{});expect(await f.r.listLangfuseIntegrations(f.projectId)).toEqual([]);
});

it('fences Ironside cursor races, remote revalidation and quarantine while preserving remote versions',async()=>{
 const f=await fixture(),version=await evaluator(f);
 const remote={protocolVersion:'ironside/evaluator/v1' as const,project:{id:'remote-project',name:'Synthetic'},capabilities:['traces:read','scores:write'] as ('traces:read'|'scores:write')[],settlement:{kind:'quiet_period' as const,quietPeriodSeconds:300}};
 const integration=await f.r.createIronsideIntegration(f.projectId,{apiKey:'synthetic',url:'https://ironside.example.test',skillVersionId:version},remote);
 await expect(f.r.createIronsideIntegration(f.projectId,{apiKey:'synthetic',url:'https://ironside.example.test'},remote)).rejects.toThrow(/already exists/);
 const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
 const cas=await Promise.all([f.r.saveIronsideSyncState(f.projectId,integration.id,{cursor:'a'},null),peer.repository.saveIronsideSyncState(f.projectId,integration.id,{cursor:'b'},null)]);expect(cas.filter(Boolean)).toHaveLength(1);
 const before=await f.r.loadIronsideImportContext({projectId:f.projectId,integrationId:integration.id,limit:5});expect(before.syncState.cursor).not.toBeNull();
 const result={ok:false,checkedAt:new Date().toISOString(),error:'Remote changed'};
 expect(await f.r.quarantineIronsideIntegration(f.projectId,integration.id,{remoteProjectId:remote.project.id,connectionRevision:1},result)).toBe(true);
 expect(await f.r.quarantineIronsideIntegration(f.projectId,integration.id,{remoteProjectId:remote.project.id,connectionRevision:1},result)).toBe(false);
 expect(await f.r.claimDueIronsideImportTargets({now:new Date(),batchSize:5,defaultLimit:25,intervalMs:60_000})).toEqual([]);
 await expect(f.r.updateIronsideIntegration(f.projectId,integration.id,{pollEnabled:true},remote,{remoteProjectId:remote.project.id,revalidationRequired:false,connectionRevision:1})).rejects.toThrow(/changed/);
 await f.r.updateIronsideIntegration(f.projectId,integration.id,{pollEnabled:true,webUrl:null},remote,{remoteProjectId:remote.project.id,revalidationRequired:true,connectionRevision:2});
 const revalidated=await f.r.loadIronsideImportContext({projectId:f.projectId,integrationId:integration.id,limit:5});expect(revalidated).toMatchObject({connectionRevision:3,revalidationRequired:false,syncState:before.syncState});
 expect(await f.r.claimDueIronsideImportTargets({now:new Date(),batchSize:5,defaultLimit:25,intervalMs:60_000})).toHaveLength(1);
 for(const sourceTraceVersion of ['version-a','version-b'])await f.r.importTrace(f.projectId,'ironside',{sourceTraceId:'remote-trace',input:'x',output:'y',metadata:{}},{ingestionPurpose:'analysis_eligible_ironside',sourceIntegrationId:integration.id,sourceRemoteProjectId:remote.project.id,sourceTraceVersion});
 expect((await f.r.findImportedIronsideTraces({projectIds:[f.projectId],remoteProjectId:remote.project.id,traceId:'remote-trace'})).map(row=>row.traceVersion)).toEqual(['version-a','version-b']);
 expect(await f.r.findImportedIronsideTraces({projectIds:['other'],remoteProjectId:remote.project.id,traceId:'remote-trace'})).toEqual([]);
 const imported=(await f.r.findImportedIronsideTraces({projectIds:[f.projectId],remoteProjectId:remote.project.id,traceId:'remote-trace'}))[0]!;
 const judged=await f.r.recordJudgeRun({projectId:f.projectId,caseId:imported.caseId,skillVersionId:version,verdict:{label:'fail',score:0.1,confidence:0.9}});
 const feedback=await f.r.createFeedbackSyncJob({projectId:f.projectId,judgeRunId:judged.id,provider:'ironside'}),feedbackJob={projectId:f.projectId,feedbackSyncJobId:feedback!.id};
 expect(await f.r.loadFeedbackSyncContext(feedbackJob)).toMatchObject({sourceTraceVersion:'version-a',integration:{provider:'ironside',connectionRevision:3,revalidationRequired:false,apiKey:'synthetic'}});
 await f.r.markFeedbackSyncBlocked(feedbackJob,'Remote revalidation');expect(await f.r.listBlockedIronsideFeedbackSyncJobs(f.projectId,integration.id)).toEqual([feedbackJob]);
 expect(await f.r.listBlockedIronsideFeedbackSyncJobs('other',integration.id)).toEqual([]);

 await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
 expect((await restarted.repository.loadIronsideImportContext({projectId:f.projectId,integrationId:integration.id,limit:5})).syncState).toEqual(before.syncState);
 await restarted.repository.deleteIronsideIntegration(f.projectId,integration.id,{});expect(await restarted.repository.listIronsideIntegrations(f.projectId)).toEqual([]);
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('retains exact feedback context, fences terminal success, and atomically refreshes coverage',async()=>{
 const f=await fixture(),version=await evaluator(f),integration=await f.r.createLangSmithIntegration(f.projectId,{apiKey:'synthetic-secret',skillVersionId:version});
 const trace=await f.r.importTrace(f.projectId,'langsmith',{sourceTraceId:'feedback-trace',input:'x',output:'y',metadata:{}},{ingestionPurpose:'analysis_eligible_langsmith',sourceIntegrationId:integration.id});
 const judged=await f.r.recordJudgeRun({projectId:f.projectId,caseId:trace.caseId,skillVersionId:version,verdict:{label:'pass',score:0.9,confidence:0.9,reason:'Synthetic'}});
 const input={projectId:f.projectId,judgeRunId:judged.id,provider:'langsmith' as const};
 const jobs=await Promise.all([f.r.createFeedbackSyncJob(input),f.r.createFeedbackSyncJob(input)]);expect(jobs[0]).toEqual(jobs[1]);const job={projectId:f.projectId,feedbackSyncJobId:jobs[0]!.id};
 expect(await f.r.loadFeedbackSyncContext(job)).toMatchObject({id:job.feedbackSyncJobId,provider:'langsmith',sourceTraceId:'feedback-trace',criterionStableKey:'grounded',judgeRun:{id:judged.id,caseId:trace.caseId,skillVersionId:version,executionBinding:MOCK_BINDING},integration:{apiKey:'synthetic-secret'}});
 await expect(f.r.loadFeedbackSyncContext({...job,projectId:'other'})).rejects.toThrow(/not found/);
 await f.r.markFeedbackSyncBlocked(job,PROVISIONAL_FEEDBACK_HOLD);expect(await f.r.listSignedOffFeedbackSyncJobs(10)).toEqual([]);
 await f.r.markFeedbackSyncPending(job);await f.r.markFeedbackSyncFailed(job,new Error('Synthetic failure'));
 expect((await f.r.listFeedbackSyncJobs({projectId:f.projectId,limit:10}))[0]).toMatchObject({status:'failed',attempts:1,lastError:'Synthetic failure'});
 f.db.exec("CREATE TRIGGER reject_coverage BEFORE UPDATE OF sync_back_coverage ON projects BEGIN SELECT RAISE(ABORT,'injected coverage failure'); END");
 await expect(f.r.markFeedbackSyncSucceeded(job)).rejects.toThrow(/injected/);expect((await f.r.listFeedbackSyncJobs({projectId:f.projectId,limit:10}))[0]?.status).toBe('failed');f.db.exec('DROP TRIGGER reject_coverage');
 await f.r.markFeedbackSyncSucceeded(job);await f.r.markFeedbackSyncFailed(job,'late failure');await f.r.markFeedbackSyncBlocked(job,'late block');await f.r.markFeedbackSyncPending(job);
 expect((await f.r.listFeedbackSyncJobs({projectId:f.projectId,limit:10}))[0]).toMatchObject({status:'synced',attempts:1,lastError:null});expect(await f.r.createFeedbackSyncJob(input)).toBeNull();
 expect(f.db.prepare('SELECT sync_back_coverage FROM projects WHERE id=?').get(f.projectId)?.sync_back_coverage).toBe(1);
 await f.r.deleteLangSmithIntegration(f.projectId,integration.id,{});await expect(f.r.loadFeedbackSyncContext(job)).rejects.toThrow(/not found/);
 await f.r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT count(*) n FROM feedback_sync_jobs').get()?.n).toBe(0);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
