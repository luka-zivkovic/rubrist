import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
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
  const trace=await r.importTrace(projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'judge_api'});
  const judge=await r.recordJudgeRun({projectId,caseId:trace.caseId,skillVersionId:versionId,verdict:{label:'fail',score:0.1,confidence:0.9,reason:'Synthetic failure'}});
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  return {dir,path,runtime,r,projectId,user,versionId,criterionVersionId,trace,judge,db};
}

it('projects customer-only onboarding and dashboard evidence with criterion-scoped exceptions',async()=>{
 const f=await fixture();
 const first=await f.r.getDashboardSummary(f.projectId);expect(first).toMatchObject({currentVersionResultCount:1,verdictDistribution:{pass:0,fail:1,ambiguous:0},exceptionsTotal:1,goldenSetSize:0});expect(first.exceptions[0]?.id).toBeDefined();
 await f.r.importTrace(f.projectId,'manual',{input:null,output:null,steps:[{input:'step',output:'answer'}],metadata:{origin:'synthetic'}},{ingestionPurpose:'dataset_example'});
 await f.r.importTrace(f.projectId,'release_evidence',{input:'release',output:'evidence',metadata:{}},{ingestionPurpose:'release_evidence'});
 expect(await f.r.getOnboardingEvidenceInventory(f.projectId)).toEqual({runCount:2,inputCount:1,outputCount:1,stepsCount:1,metadataCount:1});
 await f.r.recordVerdict({projectId:f.projectId,caseId:f.trace.caseId,skillVersionId:f.versionId,source:'human',actorUserId:f.user.id,payload:{kind:'binary',pass:true,rationale:'Reviewed'}});
 expect((await f.r.getDashboardSummary(f.projectId)).exceptionsTotal).toBe(0);
 const other=await f.r.createCriterion(f.projectId,{...definition,stableKey:'other'},{});expect((await f.r.getDashboardSummary(f.projectId,other.criterion.id)).currentVersionResultCount).toBe(0);
 await expect(f.r.getDashboardSummary(f.projectId)).rejects.toThrow(/explicit|criterion|scope/);
 expect(await f.r.getOnboardingEvidenceInventory('other')).toEqual({runCount:0,inputCount:0,outputCount:0,stepsCount:0,metadataCount:0});
});

it('prunes ordinary traffic atomically while protecting golden, revision, review and receipt evidence',async()=>{
 const f=await fixture();await f.r.updateProjectSettings(f.projectId,{traceRetentionDays:1},{});
 await f.r.promoteExceptionToGoldenSet({projectId:f.projectId,caseId:f.trace.caseId,skillVersionId:f.versionId,agreedLabel:'fail',reason:'Reviewed'});
 const dataset=await f.r.createDataset({projectId:f.projectId,name:'Frozen'});
 const revisionSource=await f.r.importDatasetExamples({projectId:f.projectId,datasetId:dataset.id,ingestionPurpose:'dataset_example',items:[{sourceTraceId:'frozen',input:'x',output:'y',metadata:{}}]});await f.r.createDatasetRevision({projectId:f.projectId,datasetId:dataset.id,role:'analysis_authoring'});
 const review=await f.r.importTrace(f.projectId,'manual',{sourceTraceId:'review',input:'x',output:'y',metadata:{}},{ingestionPurpose:'judge_api'});
 const judged=await f.r.recordJudgeRun({projectId:f.projectId,caseId:review.caseId,skillVersionId:f.versionId,verdict:{label:'fail',score:0.1,confidence:0.9}});
 await f.r.createReviewQueue({projectId:f.projectId,name:'Pinned',criterionVersionId:f.criterionVersionId,skillVersionId:f.versionId,judgeRunIds:{[review.caseId]:judged.id},caseIds:[review.caseId]});
 const released=await f.r.importTrace(f.projectId,'release_evidence',{input:'release',output:'evidence',metadata:{}},{ingestionPurpose:'release_evidence'});
 const integration=await f.r.createLangSmithIntegration(f.projectId,{apiKey:'synthetic',projectName:'retention',skillVersionId:f.versionId});
 const ordinary=await f.r.importTrace(f.projectId,'langsmith',{sourceTraceId:'ordinary',input:'x',output:'y',metadata:{}},{ingestionPurpose:'analysis_eligible_langsmith',sourceIntegrationId:integration.id});
 const ordinaryJudge=await f.r.recordJudgeRun({projectId:f.projectId,caseId:ordinary.caseId,skillVersionId:f.versionId,verdict:{label:'pass',score:0.9,confidence:0.9}});
 const feedback=await f.r.createFeedbackSyncJob({projectId:f.projectId,judgeRunId:ordinaryJudge.id,provider:'langsmith'});
 await f.r.markFeedbackSyncSucceeded({projectId:f.projectId,feedbackSyncJobId:feedback!.id});
 expect(f.db.prepare('SELECT sync_back_coverage FROM projects WHERE id=?').get(f.projectId)?.sync_back_coverage).toBe(1);
 const automatic=await f.r.createImportedCaseEvalRun({projectId:f.projectId,caseId:ordinary.caseId,skillVersionId:f.versionId});
 const now=new Date(Date.now()+2*86400000);
 f.db.exec("CREATE TRIGGER reject_retention_audit BEFORE INSERT ON audit_logs WHEN NEW.action='project.retention.prune' BEGIN SELECT RAISE(ABORT,'injected retention failure'); END");
 await expect(f.r.pruneExpiredTraces(f.projectId,{now})).rejects.toThrow(/injected/);expect(await f.r.caseExistsForProject(f.projectId,ordinary.caseId)).toBe(true);expect(await f.r.getEvalRun(f.projectId,automatic.run.id)).not.toBeNull();f.db.exec('DROP TRIGGER reject_retention_audit');
 expect(await f.r.pruneExpiredTraces(f.projectId,{now})).toMatchObject({deletedCases:1,deletedRawTraces:1,skippedActiveGoldenCases:1,skippedImmutableRevisionCases:1,skippedReviewCases:1});
 for(const id of [f.trace.caseId,revisionSource.items[0]!.caseId,review.caseId,released.caseId])expect(await f.r.caseExistsForProject(f.projectId,id)).toBe(true);
 expect(await f.r.getEvalRun(f.projectId,automatic.run.id)).toBeNull();expect(f.db.prepare('SELECT imported_trace_count FROM projects').get()?.imported_trace_count).toBe(3);
 expect(f.db.prepare('SELECT count(*) n FROM judge_runs WHERE case_id=?').get(ordinary.caseId)?.n).toBe(0);
 expect(f.db.prepare('SELECT count(*) n FROM verdicts WHERE case_id=?').get(ordinary.caseId)?.n).toBe(0);
 expect(f.db.prepare('SELECT count(*) n FROM feedback_sync_jobs WHERE id=?').get(feedback!.id)?.n).toBe(0);
 expect(f.db.prepare('SELECT sync_back_coverage FROM projects WHERE id=?').get(f.projectId)?.sync_back_coverage).toBe(0);
 expect(await f.r.pruneExpiredTraces(f.projectId,{now})).toMatchObject({deletedCases:0,skippedActiveGoldenCases:0});
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('persists historical compatibility records against exact evaluation and golden references',async()=>{
 const f=await fixture(),golden=await f.r.promoteExceptionToGoldenSet({projectId:f.projectId,caseId:f.trace.caseId,skillVersionId:f.versionId,agreedLabel:'fail',reason:'Reviewed'});
 const candidate=await f.r.importTrace(f.projectId,'manual',{input:'candidate',output:'y',metadata:{}},{ingestionPurpose:'judge_api'});
 const run=await f.r.createEvalRun({projectId:f.projectId,skillVersionId:f.versionId,trigger:'manual',items:[{caseId:candidate.caseId,expectedLabel:'fail'}]});
 const input={projectId:f.projectId,skillVersionId:f.versionId,evalRunId:run.id,label:'Historical import',maxDisagreements:0,items:[{goldenEntryId:golden.id,goldenCaseId:f.trace.caseId,candidateCaseId:candidate.caseId,caseKey:'synthetic',expectedLabel:'fail' as const}]};
 const history=await f.r.createGateCheck(input);expect(history).toMatchObject({evalRunId:run.id,totalCandidates:1,items:[{candidateCaseId:candidate.caseId,status:'pending'}]});
 expect(await f.r.getGateCheckDetail(f.projectId,history.id)).toEqual(history);expect(await f.r.getGateCheckDetail('other',history.id)).toBeNull();expect(await f.r.listGateChecks(f.projectId)).toHaveLength(1);
 await expect(f.r.createGateCheck({...input,items:[{...input.items[0]!,candidateCaseId:f.trace.caseId}]})).rejects.toThrow(/binding/);expect(await f.r.listGateChecks(f.projectId)).toHaveLength(1);
 await f.r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
