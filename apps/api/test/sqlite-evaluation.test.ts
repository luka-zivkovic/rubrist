import {createStrictJudgeProvider} from '../src/lib/judge-provider.js';

import {SqliteQueue} from '@rubrist/queue/sqlite';
import {processEvalItemJob} from '../src/workers/eval-run.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { recoverStaleEvalRunItemExecutions } from '../src/workers/eval-run.js';
import { AssessmentReceiptIntegrityError } from '../src/repository/errors.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { EXECUTION_LEASE_MS } from '../src/storage/sqlite/eval-execution.js';
import { MOCK_BINDING, bindingInput, runtimeVersion } from './fixtures/execution-binding.js';
import { parseCanonicalReceiptBytes, canonicalReceiptBytes, evidenceDigestForReceipt, receiptArtifactDigest } from '../src/lib/assessment-receipt.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-evaluation-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-evaluation-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const r=runtime.repository;
  const definition=CreateCriterionInputSchema.parse({stableKey:'grounded',name:'Grounded',definition:'Answers follow evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge the answer.',executionBinding:bindingInput(MOCK_BINDING)}});
  const created=await r.createCriterion(projectId,definition,{actorUserId:user.id}),versionId=created.evaluator.currentVersion.id;
  const trace=await r.importTrace(projectId,'release_evidence',{sourceTraceId:'test-1',input:'question',output:'answer',metadata:{}},{ingestionPurpose:'release_evidence'});
  const owner=await r.createEvalRun({projectId,skillVersionId:versionId,trigger:'release_evidence',items:[{caseId:trace.caseId,clientItemId:'test-1',contentDigest:`sha256:${'a'.repeat(64)}`} ]});
  const execution={projectId,evalRunId:owner.id,evalRunItemId:owner.items[0]!.id,executionToken:'first'};
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  async function record(skillVersionId=versionId) { return r.recordVerdict({projectId,caseId:trace.caseId,skillVersionId,source:'llm_judge',payload:{kind:'binary',pass:true,rationale:'Grounded'},observed:{model:'mock-heuristic-v1',requestId:'synthetic',responseId:null,systemFingerprint:null,upstreamProvider:null,thinkingReturned:null,reasoningTokens:null},evaluatorScore:{value:0.9,kind:'self_reported_score'}}); }
  async function start() { expect(await r.claimEvalRunItemExecution(execution)).toEqual({state:'claimed'});expect(await r.beginEvalRunItemProviderCall(execution)).toBe(true);expect(await r.markEvalRunItemProviderCallReturned(execution)).toBe(true); }
  return {path,runtime,projectId,r,definition,versionId,trace,owner,execution,db,record,start};
}
describe('SQLite durable evaluation and receipt ownership',()=>{
  it('rejects prefailed items atomically and initializes connection validators only once',async()=> {
    const f=await fixture();
    const before=await f.r.listEvalRuns(f.projectId);
    await expect(f.r.createEvalRun({projectId:f.projectId,skillVersionId:f.versionId,trigger:'release_evidence',items:[{caseId:f.trace.caseId,status:'failed' as 'pending'}]})).rejects.toThrow(/Invalid evaluation item status at creation/);
    expect(await f.r.listEvalRuns(f.projectId)).toEqual(before);
    const register=vi.spyOn(f.db,'function');
    sqliteCommands(f.db);sqliteCommands(f.db);
    expect(register.mock.calls.map(call=>call[0]).filter(name=>['sqlite_subject_digest','sqlite_criterion_digest','sqlite_execution_authorization_digest','sqlite_skill_version_valid','sqlite_receipt_valid','sqlite_comparison_valid'].includes(name))).toEqual([]);
    register.mockRestore();
    expect(f.db.prepare("SELECT sqlite_subject_digest('project','subject') digest").get()?.digest).toMatch(/^sha256:/);
  });
  it('preserves collection item identity under terminal evaluations while allowing label edits and removal',async()=> {
    const f=await fixture();
    const trace=await f.r.importTrace(f.projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'dataset_example'});
    const dataset=await f.r.createDataset({projectId:f.projectId,name:'Identity'});
    const [item]=await f.r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:trace.caseId}]});
    const run=await f.r.createEvalRun({projectId:f.projectId,datasetId:dataset.id,skillVersionId:f.versionId,trigger:'manual',items:[{caseId:trace.caseId,datasetItemId:item!.id,status:'skipped'}]});
    expect(run.status).toBe('completed');
    expect(()=>f.db.prepare('UPDATE eval_run_items SET dataset_item_id=NULL WHERE id=?').run(run.items[0]!.id)).toThrow(/immutable eval dataset item/);
    expect((await f.r.getEvalRunDetail(f.projectId,run.id))?.items[0]?.datasetItemId).toBe(item!.id);
    const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'second@example.test',password:'synthetic-long-password',name:'Second'}});
    const other=await f.runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
    const otherTrace=await f.r.importTrace(other.projectId,'manual',{input:'other',output:'other',metadata:{}},{ingestionPurpose:'dataset_example'});
    const otherDataset=await f.r.createDataset({projectId:other.projectId,name:'Other'});
    expect(()=>f.db.prepare('UPDATE dataset_items SET project_id=?,dataset_id=?,case_id=?,trace_id=? WHERE id=?').run(other.projectId,otherDataset.id,otherTrace.caseId,otherTrace.rawTraceId,item!.id)).toThrow(/immutable dataset item identity/);
    for(const column of ['id','trace_id','added_at']) expect(()=>f.db.prepare(`UPDATE dataset_items SET ${column}=? WHERE id=?`).run('changed',item!.id)).toThrow(/immutable dataset item identity/);
    await f.r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:trace.caseId,expectedLabel:'fail',expectedFailStep:0,note:'Editable'}]});
    expect(await f.r.removeDatasetItem(f.projectId,dataset.id,item!.id)).toBe(true);
    expect((await f.r.getEvalRunDetail(f.projectId,run.id))?.items[0]?.datasetItemId).toBeNull();
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('protects terminal run creator attribution and permits account erasure',async()=> {
    const f=await fixture();
    const author=f.db.prepare('SELECT id FROM "user"').get()!.id as string;
    const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'replacement@example.test',password:'synthetic-long-password',name:'Replacement'}});
    const run=await f.r.createEvalRun({projectId:f.projectId,skillVersionId:f.versionId,trigger:'manual',createdByUserId:author,items:[]});
    expect(run.status).toBe('completed');
    for(const replacement of [user.id,null]) expect(()=>f.db.prepare('UPDATE eval_runs SET created_by_user_id=? WHERE id=?').run(replacement,run.id)).toThrow(/immutable eval run creator/);
    f.db.prepare('DELETE FROM "user" WHERE id=?').run(author);
    expect(f.db.prepare('SELECT created_by_user_id FROM eval_runs WHERE id=?').get(run.id)?.created_by_user_id).toBeNull();
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('retains uncertainty after SIGKILL during the provider call, then mints one failure receipt on restart',async()=> {
    const f=await fixture();
    const child=fork(fileURLToPath(new URL('./fixtures/sqlite-interrupted-evaluation.ts',import.meta.url)),[f.path,JSON.stringify({...f.execution,caseId:f.trace.caseId,skillVersionId:f.versionId})],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
    cleanup.push(()=>{if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');});
    let errors='';child.stderr?.on('data',data=>{errors+=String(data);});
    const started=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(errors);})]);
    expect(started[0]).toEqual({dispatched:true});
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    await f.runtime.close();
    const next=await createSqliteRuntime(f.path);cleanup.push(()=>next.close());
    f.db.prepare('UPDATE eval_run_items SET execution_claimed_at=? WHERE id=?').run(Date.now()-EXECUTION_LEASE_MS-100,f.execution.evalRunItemId);
    await recoverStaleEvalRunItemExecutions(next.repository,next.queue);
    const root=(await next.repository.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!;
    expect(parseCanonicalReceiptBytes(root.canonicalBytes).items[0]?.result).toMatchObject({state:'failure',failureKind:'outcome_unknown'});
    await recoverStaleEvalRunItemExecutions(next.repository,next.queue);
    expect(await next.repository.listAssessmentReceiptArtifacts(f.projectId,f.owner.id)).toEqual([root]);
    expect(await next.repository.listVerdicts({projectId:f.projectId,limit:10})).toEqual([]);
  });

  it('commits terminal evidence exactly once, revives BLOBs across RPC and restart, and retains evidence through traffic deletion',async()=> {
    const f=await fixture();await f.start();const verdict=await f.record();
    const input={...f.execution,verdictId:verdict.id,resultLabel:'pass'};
    expect(await f.r.completeEvalRunItem(input)).toEqual({runFinished:true});
    expect(await f.r.completeEvalRunItem(input)).toEqual({runFinished:true});
    expect((await f.r.getEvalRun(f.projectId,f.owner.id))?.completedItems).toBe(1);
    const root=(await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!;
    expect(Buffer.isBuffer(root.canonicalBytes)).toBe(true);expect(parseCanonicalReceiptBytes(root.canonicalBytes).items).toHaveLength(1);
    const comparison=await f.r.compareAssessmentReceiptCopy({projectId:f.projectId,evalRunId:f.owner.id,consumerCanonicalBytes:root.canonicalBytes});
    expect(comparison.comparisonStatus).toBe('match');expect(comparison.consumerCanonicalBytes.equals(root.canonicalBytes)).toBe(true);
    await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
    expect(await restarted.repository.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id)).toEqual(root);
    sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM cases WHERE id=?').run(f.trace.caseId));
    expect(await restarted.repository.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id)).toEqual(root);
    await restarted.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
    expect(f.db.prepare('SELECT count(*) n FROM assessment_receipt_artifacts').get()?.n).toBe(0);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it.each(['completed','failed'] as const)('preserves terminal %s start time against rewriting and clearing',async(status)=> {
    const f=await fixture();
    expect((await f.r.getEvalRun(f.projectId,f.owner.id))?.startedAt).toBeNull();
    await f.r.markEvalRunRunning(f.projectId,f.owner.id);
    await f.start();
    const started=(await f.r.getEvalRun(f.projectId,f.owner.id))!.startedAt;
    expect(started).not.toBeNull();
    if(status==='completed') {const verdict=await f.record();await f.r.completeEvalRunItem({...f.execution,verdictId:verdict.id,resultLabel:'pass'});}
    else await f.r.failEvalRunItem({...f.execution,error:'synthetic failure',failure:{state:'failure',failureKind:'provider_protocol',observed:{model:'mock-heuristic-v1',requestId:'synthetic',responseId:null,systemFingerprint:null,upstreamProvider:null,thinkingReturned:null,reasoningTokens:null}}});
    const receipt=await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id);
    expect((await f.r.getEvalRun(f.projectId,f.owner.id))?.status).toBe(status);
    for(const value of ['2020-01-01T00:00:00.000Z',null])expect(()=>f.db.prepare('UPDATE eval_runs SET started_at=? WHERE id=?').run(value,f.owner.id)).toThrow(/immutable terminal eval run/);
    expect(()=>f.db.prepare('UPDATE eval_runs SET blocking=1-blocking WHERE id=?').run(f.owner.id)).toThrow(/immutable terminal eval run/);
    expect((await f.r.getEvalRun(f.projectId,f.owner.id))?.startedAt).toBe(started);
    expect(await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id)).toEqual(receipt);
  });
  it('fences live, replaced and expired claims, and does not repeat a provider call after uncertainty',async()=> {
    const f=await fixture(),next={...f.execution,executionToken:'next'};
    expect(await f.r.claimEvalRunItemExecution(f.execution)).toEqual({state:'claimed'});
    expect(await f.r.claimEvalRunItemExecution(next)).toEqual({state:'busy'});
    f.db.prepare('UPDATE eval_run_items SET execution_claimed_at=? WHERE id=?').run(Date.now()-EXECUTION_LEASE_MS-100,f.execution.evalRunItemId);
    expect(await f.r.claimEvalRunItemExecution(next)).toEqual({state:'claimed'});
    expect(await f.r.beginEvalRunItemProviderCall(f.execution)).toBe(false);
    expect(await f.r.beginEvalRunItemProviderCall(next)).toBe(true);
    expect(await f.r.beginEvalRunItemProviderCall(next)).toBe(false);
    expect(await f.r.markEvalRunItemProviderCallReturned(next)).toBe(true);
    expect(await f.r.claimEvalRunItemExecution(f.execution)).toEqual({state:'busy'});
    const verdict=await f.record();f.db.prepare('UPDATE eval_run_items SET execution_claimed_at=? WHERE id=?').run(Date.now()-EXECUTION_LEASE_MS-100,f.execution.evalRunItemId);
    expect(await f.r.completeEvalRunItem({...next,verdictId:verdict.id,resultLabel:'pass'})).toEqual({runFinished:false});
    expect(await f.r.claimEvalRunItemExecution(f.execution)).toEqual({state:'outcome_unknown',executionToken:'next',providerCallReturned:true});
    await f.r.failEvalRunItem({...next,recoverExpiredClaim:true,error:'Lost result',failure:{state:'failure',failureKind:'outcome_unknown',observed:verdict.observed!}});
    const receipt=parseCanonicalReceiptBytes((await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!.canonicalBytes);
    expect(receipt.items[0]?.result).toMatchObject({state:'failure',failureKind:'outcome_unknown'});
  });
  it('fences expired handler failures and admits only expiry-checked recovery classifications',async()=> {
    const f=await fixture();await f.start();const verdict=await f.record();
    const unknown={state:'failure' as const,failureKind:'outcome_unknown' as const,observed:verdict.observed!};
    expect(await f.r.failEvalRunItem({...f.execution,recoverExpiredClaim:true,error:'premature',failure:unknown})).toEqual({runFinished:false});
    f.db.prepare('UPDATE eval_run_items SET execution_claimed_at=? WHERE id=?').run(Date.now()-EXECUTION_LEASE_MS-1,f.execution.evalRunItemId);
    expect(await f.r.failEvalRunItem({...f.execution,error:'late callback',failure:{...unknown,failureKind:'provider_protocol'}})).toEqual({runFinished:false});
    expect(await f.r.failEvalRunItem({...f.execution,error:'late refusal',failure:{state:'not_attempted',executorRefused:true}})).toEqual({runFinished:false});
    expect(await f.r.failEvalRunItem({...f.execution,recoverExpiredClaim:true,error:'wrong classification',failure:{state:'not_attempted'}})).toEqual({runFinished:false});
    expect(await f.r.failEvalRunItem({...f.execution,recoverExpiredClaim:true,executionToken:'replaced',error:'wrong token',failure:unknown})).toEqual({runFinished:false});
    await recoverStaleEvalRunItemExecutions(f.r);
    const receipt=(await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!;
    expect(parseCanonicalReceiptBytes(receipt.canonicalBytes).items[0]?.result).toMatchObject({state:'failure',failureKind:'outcome_unknown'});
    expect(await f.r.failEvalRunItem({...f.execution,error:'late callback',failure:{...unknown,failureKind:'provider_protocol'}})).toEqual({runFinished:true});
    expect(await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id)).toEqual(receipt);
  });
  it('rolls back item/counter updates if receipt minting fails and rejects wrong-version or misleading result projections',async()=> {
    const f=await fixture();await f.start();
    const second=await f.r.createCriterion(f.projectId,{...f.definition,stableKey:'second'},{}),wrong=await f.record(second.evaluator.currentVersion.id);
    await expect(f.r.completeEvalRunItem({...f.execution,verdictId:wrong.id,resultLabel:'pass'})).rejects.toThrow(/exact evaluator/);
    await expect(f.r.createEvalRun({projectId:f.projectId,skillVersionId:f.versionId,trigger:'release_evidence',items:[{caseId:f.trace.caseId,status:'completed',verdictId:wrong.id,resultLabel:'pass',cached:true}]})).rejects.toThrow(/exact evaluator/);
    const verdict=await f.record();
    await expect(f.r.completeEvalRunItem({...f.execution,verdictId:verdict.id,resultLabel:'fail'})).rejects.toThrow(/projection/);
    f.db.exec("CREATE TRIGGER inject_receipt_failure BEFORE INSERT ON assessment_receipt_artifacts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
    await expect(f.r.completeEvalRunItem({...f.execution,verdictId:verdict.id,resultLabel:'pass'})).rejects.toThrow(/injected/);
    expect((await f.r.getEvalRunDetail(f.projectId,f.owner.id))?.items[0]?.status).toBe('pending');
    expect((await f.r.getEvalRun(f.projectId,f.owner.id))?.completedItems).toBe(0);
    f.db.exec('DROP TRIGGER inject_receipt_failure');
    expect(await f.r.completeEvalRunItem({...f.execution,verdictId:verdict.id,resultLabel:'pass'})).toEqual({runFinished:true});
  });
  it('rejects unowned terminal writes and terminal release commits without a receipt',async()=> {
    const f=await fixture();await f.start();const verdict=await f.record();
    expect(await f.r.completeEvalRunItem({...f.execution,executionToken:undefined,verdictId:verdict.id,resultLabel:'pass'})).toEqual({runFinished:false});
    expect(await f.r.failEvalRunItem({...f.execution,executionToken:'wrong',error:'no',failure:{state:'not_attempted'}})).toEqual({runFinished:false});
    expect(await f.r.failEvalRunItem({...f.execution,error:'no',failure:{state:'not_attempted'}})).toEqual({runFinished:false});
    f.db.exec('BEGIN IMMEDIATE');
    f.db.prepare("UPDATE eval_runs SET status='completed',completed_items=1,finished_at=? WHERE id=?").run(new Date().toISOString(),f.owner.id);
    expect(()=>f.db.exec('COMMIT')).toThrow(/FOREIGN KEY/);f.db.exec('ROLLBACK');
    expect(await f.r.getEvalRun('other',f.owner.id)).toBeNull();
  });
  it('appends corrections, rejects tampering, and preserves maintenance without registered functions',async()=> {
    const f=await fixture();await f.start();const verdict=await f.record();await f.r.completeEvalRunItem({...f.execution,verdictId:verdict.id,resultLabel:'pass'});
    const root=(await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!,receipt=parseCanonicalReceiptBytes(root.canonicalBytes);
    const corrected={...receipt,receiptId:'receipt_corrected'};corrected.evidenceDigest=evidenceDigestForReceipt(corrected);
    const correction=await f.r.createAssessmentReceiptCorrection({projectId:f.projectId,evalRunId:f.owner.id,receipt:corrected,reason:'Document correction'});
    await expect(f.r.compareAssessmentReceiptCopy({projectId:f.projectId,evalRunId:f.owner.id,consumerCanonicalBytes:Buffer.from('{}')})).rejects.toBeInstanceOf(AssessmentReceiptIntegrityError);
    await expect(f.r.createAssessmentReceiptCorrection({projectId:f.projectId,evalRunId:f.owner.id,receipt:{} as never,reason:'Invalid'})).rejects.toBeInstanceOf(AssessmentReceiptIntegrityError);
    expect(correction.predecessorArtifactId).toBe(root.id);expect(correction.artifactRevision).toBe(2);
    expect(correction.canonicalBytes.equals(canonicalReceiptBytes(corrected))).toBe(true);
    const third={...corrected,receiptId:'receipt_third'};third.evidenceDigest=evidenceDigestForReceipt(third);
    const retained=f.db.prepare('SELECT * FROM assessment_receipt_artifacts WHERE id=?').get(correction.id)!;
    const bytes=canonicalReceiptBytes(third);
    const candidate={...retained,id:'rart_third',receipt_id:third.receiptId,artifact_revision:3,canonical_bytes:bytes,artifact_digest:receiptArtifactDigest(bytes),evidence_digest:third.evidenceDigest,predecessor_artifact_id:correction.id};
    function insert(overrides:Record<string,unknown>) {
      const row={...candidate,...overrides};
      f.db.prepare(`INSERT INTO assessment_receipt_artifacts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row) as never[]);
    }
    for(const reason of [null,'','  ','\t','\n','\u00a0',' \t\r\n\u00a0\u2003\ufeff']) {
      expect(()=>insert({correction_reason:reason})).toThrow(/correction reason/);
    }
    expect(()=>insert({canonical_bytes:Buffer.from('{}')})).toThrow(/receipt bytes/);
    expect(()=>insert({artifact_digest:`sha256:${'0'.repeat(64)}`})).toThrow(/receipt bytes/);
    expect(()=>insert({predecessor_artifact_id:root.id})).toThrow(/predecessor/);
    expect(()=>insert({source_snapshot_digest:'not-a-digest'})).toThrow(/CHECK/);
    insert({correction_reason:'\tCorrected source attribution\u00a0'});
    expect(f.db.prepare('SELECT correction_reason FROM assessment_receipt_artifacts WHERE id=?').get('rart_third')?.correction_reason).toBe('\tCorrected source attribution\u00a0');
    expect(()=>f.db.exec("UPDATE assessment_receipt_artifacts SET canonical_bytes=x'00'")).toThrow(/immutable/);
    expect(()=>f.db.exec('DELETE FROM assessment_receipt_artifacts')).toThrow(/erasure/);
    const plain=openSqlite(f.path);cleanup.push(()=>plain.close());expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(plain.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

it.each(['claimed','verdict']as const)('recovers a production SIGKILL after %s without guessing a provider result',async phase=>{
 const f=await fixture(),job={...f.execution,caseId:f.trace.caseId,skillVersionId:f.versionId};
 const child=fork(fileURLToPath(new URL('./fixtures/sqlite-interrupted-evaluation.ts',import.meta.url)),[f.path,JSON.stringify(job),phase],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
 cleanup.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 let errors='';child.stderr?.on('data',data=>{errors+=String(data);});
 const started=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error(errors);})]);
 expect(started[0]).toEqual({phase,physicalCalls:phase==='claimed'?0:1});
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 await f.runtime.close();const next=await createSqliteRuntime(f.path);cleanup.push(()=>next.close());
 f.db.prepare('UPDATE eval_run_items SET execution_claimed_at=? WHERE id=?').run(Date.now()-EXECUTION_LEASE_MS-100,f.execution.evalRunItemId);
 const provider=createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)),calls=vi.spyOn(provider,'judgeStructured');
 await processEvalItemJob(next.repository,job,provider,'restarted');
 expect(calls).toHaveBeenCalledTimes(phase==='claimed'?1:0);
 const receipt=(await next.repository.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!;
 expect(parseCanonicalReceiptBytes(receipt.canonicalBytes).items[0]?.result).toMatchObject(phase==='claimed'?{state:'outcome'}:{state:'failure',failureKind:'outcome_unknown'});
 expect(await next.repository.listVerdicts({projectId:f.projectId,limit:10})).toHaveLength(1);
 await processEvalItemJob(next.repository,job,provider,'replay');
 expect(await next.repository.listAssessmentReceiptArtifacts(f.projectId,f.owner.id)).toEqual([receipt]);
 expect(calls).toHaveBeenCalledTimes(phase==='claimed'?1:0);
});
it('redelivers a terminal evaluation after failed acknowledgement without repeating the model call',async()=>{
 const f=await fixture(),storage=f.runtime.storage,provider=createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)),calls=vi.spyOn(provider,'judgeStructured');
 const failed=vi.spyOn(console,'error').mockImplementation(()=>{});cleanup.push(()=>{failed.mockRestore();});
 const queue=new SqliteQueue({
  send:(...args)=>storage.command('queueSend',...args),state:(...args)=>storage.command('queueState',...args),
  claim:(...args)=>storage.command('queueClaim',...args),recover:(...args)=>storage.command('queueRecover',...args),
  settle:async()=>{throw Error('synthetic acknowledgement connection loss');}
 },{pollMs:5});cleanup.push(()=>queue.stop());
 const job={projectId:f.projectId,evalRunId:f.owner.id,evalRunItemId:f.execution.evalRunItemId,caseId:f.trace.caseId,skillVersionId:f.versionId};
 await queue.work<typeof job>('eval.item',delivery=>processEvalItemJob(f.r,delivery.data,provider,delivery.id));
 await queue.send('eval.item',job,{id:'ack-after-receipt',expireInSeconds:1,retryLimit:2});await queue.start();
 await vi.waitFor(()=>expect(failed).toHaveBeenCalled(),{timeout:5000});await queue.stop();
 expect(calls).toHaveBeenCalledOnce();expect(await queue.getJobState('eval.item','ack-after-receipt')).toBe('active');
 const receipt=(await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!;
 const counts=await f.r.getEvalRun(f.projectId,f.owner.id);
 await f.runtime.close();const next=await createSqliteRuntime(f.path);cleanup.push(()=>next.close());
 await next.queue.work<typeof job>('eval.item',delivery=>processEvalItemJob(next.repository,delivery.data,provider,delivery.id));await next.queue.start();
 await vi.waitFor(async()=>expect(await next.queue.getJobState('eval.item','ack-after-receipt')).toBe('completed'),{timeout:5000});
 expect(calls).toHaveBeenCalledOnce();expect(await next.repository.listVerdicts({projectId:f.projectId,limit:10})).toHaveLength(1);
 expect(await next.repository.listAssessmentReceiptArtifacts(f.projectId,f.owner.id)).toEqual([receipt]);
 expect(await next.repository.getEvalRun(f.projectId,f.owner.id)).toEqual(counts);
});
