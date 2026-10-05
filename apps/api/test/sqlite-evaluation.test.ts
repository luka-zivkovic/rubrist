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
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { EXECUTION_LEASE_MS } from '../src/storage/sqlite/eval-execution.js';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
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
  it('preserves collection item identity under terminal evaluations while allowing label edits and removal',async()=> {
    const f=await fixture();
    const trace=await f.r.importTrace(f.projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'dataset_example'});
    const dataset=await f.r.createDataset({projectId:f.projectId,name:'Identity'});
    const [item]=await f.r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:trace.caseId}]});
    const run=await f.r.createEvalRun({projectId:f.projectId,datasetId:dataset.id,skillVersionId:f.versionId,trigger:'manual',items:[{caseId:trace.caseId,datasetItemId:item!.id,status:'skipped'}]});
    expect(run.status).toBe('completed');
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
    f.db.prepare('DELETE FROM cases WHERE id=?').run(f.trace.caseId);
    expect(await restarted.repository.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id)).toEqual(root);
    await restarted.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
    expect(f.db.prepare('SELECT count(*) n FROM assessment_receipt_artifacts').get()?.n).toBe(0);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
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
    await f.r.failEvalRunItem({...next,error:'Lost result',failure:{state:'failure',failureKind:'outcome_unknown',observed:verdict.observed!}});
    const receipt=parseCanonicalReceiptBytes((await f.r.getOrFreezeAssessmentReceipt(f.projectId,f.owner.id))!.canonicalBytes);
    expect(receipt.items[0]?.result).toMatchObject({state:'failure',failureKind:'outcome_unknown'});
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
    expect(()=>insert({correction_reason:null})).toThrow(/CHECK/);
    expect(()=>insert({correction_reason:'  '})).toThrow(/CHECK/);
    expect(()=>insert({canonical_bytes:Buffer.from('{}')})).toThrow(/receipt bytes/);
    expect(()=>insert({artifact_digest:`sha256:${'0'.repeat(64)}`})).toThrow(/receipt bytes/);
    expect(()=>insert({predecessor_artifact_id:root.id})).toThrow(/predecessor/);
    expect(()=>insert({source_snapshot_digest:'not-a-digest'})).toThrow(/CHECK/);
    expect(()=>f.db.exec("UPDATE assessment_receipt_artifacts SET canonical_bytes=x'00'")).toThrow(/immutable/);
    expect(()=>f.db.exec('DELETE FROM assessment_receipt_artifacts')).toThrow(/erasure/);
    const plain=openSqlite(f.path);cleanup.push(()=>plain.close());expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(plain.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
