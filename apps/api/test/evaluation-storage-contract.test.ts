import {createStrictJudgeProvider} from '../src/lib/judge-provider.js';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMigrations} from '@rubrist/db';
import {openSqlite} from '@rubrist/db/sqlite';
import {CreateCriterionInputSchema} from '@rubrist/shared';

import {createUnseededSqliteRuntime} from './helpers/sqlite.js';
import {openPostgresTestDatabase} from './helpers/postgres.js';
import {PgRepository} from '../src/repository.pg.js';
import {createAuth,type RubristAuth} from '../src/lib/auth.js';
import {createPgAccountServices} from '../src/accounts/postgres.js';
import {processEvalItemJob} from '../src/workers/eval-run.js';
import {MOCK_BINDING,bindingInput,runtimeVersion} from './fixtures/execution-binding.js';
import type {RubristRepository} from '../src/repository.js';
const cleanup:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {resolve,promise};}
async function fixture(kind:'sqlite'|'postgres'){
 vi.stubEnv('BETTER_AUTH_SECRET','synthetic-parity-secret-never-use-in-deployment');
 let withExpiringLock:((id:string,operation:()=>Promise<unknown>)=>Promise<unknown>)|undefined;
 let repository:RubristRepository,auth:RubristAuth,accounts:ReturnType<typeof createPgAccountServices>,expire:(id:string)=>Promise<void>;
 if(kind==='sqlite'){
  const directory=mkdtempSync(join(tmpdir(),'rubrist-parity-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'db.sqlite'),runtime=await createUnseededSqliteRuntime(path);cleanup.push(()=>runtime.close());
  repository=runtime.repository;auth=runtime.auth;accounts=runtime.accounts;
  expire=async id=>{const db=openSqlite(path);try{db.prepare('UPDATE eval_run_items SET execution_claimed_at=? WHERE id=?').run(Date.now()-16*60_000,id);}finally{db.close();}};
 }else{
  const db=await openPostgresTestDatabase('evaluation_parity');cleanup.push(db.cleanup);await runMigrations(db.pool);
  withExpiringLock=async(id,operation)=>{
   await db.pool.query("UPDATE eval_run_items SET execution_claimed_at=clock_timestamp()-interval '15 minutes'+interval '400 milliseconds' WHERE id=$1",[id]);
   const lock=await db.pool.connect();
   try {
    await lock.query('begin');await lock.query('SELECT id FROM eval_run_items WHERE id=$1 FOR UPDATE',[id]);
    const pending=operation();
    await new Promise(resolve=>setTimeout(resolve,700));await lock.query('commit');return await pending;
   }finally{await lock.query('rollback');lock.release();}
  };
  repository=new PgRepository(db.pool);auth=createAuth(db.pool);accounts=createPgAccountServices(db.pool);
  expire=async id=>{await db.pool.query("UPDATE eval_run_items SET execution_claimed_at=clock_timestamp()-interval '16 minutes' WHERE id=$1",[id]);};
 }
 const {user}=await auth.api.signUpEmail({body:{email:'parity@example.test',password:'synthetic-long-password',name:'Parity'}});
 const {projectId}=await accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
 const definition=CreateCriterionInputSchema.parse({stableKey:'parity',name:'Parity',definition:'The answer is grounded.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge the answer.',executionBinding:bindingInput(MOCK_BINDING)}});
 const created=await repository.createCriterion(projectId,definition,{actorUserId:user.id}),versionId=created.evaluator.currentVersion.id;
 const trace=await repository.importTrace(projectId,'release_evidence',{sourceTraceId:'parity',input:'question',output:'answer',metadata:{}},{ingestionPurpose:'release_evidence'});
 const run=await repository.createEvalRun({projectId,skillVersionId:versionId,trigger:'release_evidence',items:[{caseId:trace.caseId,clientItemId:"parity-one",contentDigest:`sha256:${"a".repeat(64)}`}]});
 const job={projectId,evalRunId:run.id,evalRunItemId:run.items[0]!.id,caseId:trace.caseId,skillVersionId:versionId};
 return {repository,job,expire,withExpiringLock};
}
for(const kind of ['sqlite','postgres']as const){
 describe.skipIf(kind==='postgres'&&!process.env.PG_SMOKE_DATABASE_URL)(`${kind} shared evaluation storage contract`,()=>{
  it.each([false,true])('rejects invalid recovery with provider dispatched=%s',async dispatched=>{
   const f=await fixture(kind),owner={...f.job,executionToken:'recovery-owner'};
   const unknown={state:'failure' as const,failureKind:'outcome_unknown' as const,observed:{model:null,requestId:null,responseId:null,systemFingerprint:null,upstreamProvider:null,thinkingReturned:null,reasoningTokens:null}};
   const expected=dispatched?unknown:{state:'not_attempted' as const};
   expect(await f.repository.claimEvalRunItemExecution(owner)).toEqual({state:'claimed'});
   if(dispatched)expect(await f.repository.beginEvalRunItemProviderCall(owner)).toBe(true);
   expect(await f.repository.failEvalRunItem({...owner,recoverExpiredClaim:true,error:'premature recovery',failure:expected})).toEqual({runFinished:false});
   await f.expire(f.job.evalRunItemId);
   const invalid=[
    {...owner,error:'late provider failure',failure:{...unknown,failureKind:'provider_protocol' as const}},
    {...owner,error:'late executor refusal',failure:{state:'not_attempted' as const,executorRefused:true as const}},
    {...owner,recoverExpiredClaim:true,error:'wrong classification',failure:dispatched?{state:'not_attempted' as const}:unknown},
    {...owner,recoverExpiredClaim:true,error:'non-recovery failure kind',failure:{...unknown,failureKind:'provider_protocol' as const}},
    {...owner,recoverExpiredClaim:true,executionToken:'wrong-owner',error:'wrong token',failure:expected}
   ];
   for(const input of invalid)expect(await f.repository.failEvalRunItem(input)).toEqual({runFinished:false});
   expect((await f.repository.getEvalRunDetail(f.job.projectId,f.job.evalRunId))?.items[0]?.status).toBe('pending');
   expect(await f.repository.listAssessmentReceiptArtifacts(f.job.projectId,f.job.evalRunId)).toEqual([]);
   expect(await f.repository.failEvalRunItem({...owner,recoverExpiredClaim:true,error:'expired recovery',failure:expected})).toEqual({runFinished:true});
   const receipt=(await f.repository.getOrFreezeAssessmentReceipt(f.job.projectId,f.job.evalRunId))!;
   expect(JSON.parse(receipt.canonicalBytes.toString()).items[0].result).toEqual(dispatched?{state:'failure',failureKind:'outcome_unknown'}:{state:'not_attempted'});
   expect(await f.repository.getEvalRun(f.job.projectId,f.job.evalRunId)).toMatchObject({status:'failed',completedItems:0,failedItems:1});
  });
  it('fences overlapping deliveries and keeps one terminal artifact on replay',async()=>{
   const f=await fixture(kind),provider=createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)),base=provider.judgeStructured.bind(provider),entered=deferred(),release=deferred();
   const calls=vi.spyOn(provider,'judgeStructured').mockImplementation(async input=>{entered.resolve();await release.promise;return base(input);});
   const first=processEvalItemJob(f.repository,f.job,provider,'first');await entered.promise;
   await processEvalItemJob(f.repository,f.job,provider,'overlap');expect(calls).toHaveBeenCalledOnce();release.resolve();await first;
   const receipt=await f.repository.getOrFreezeAssessmentReceipt(f.job.projectId,f.job.evalRunId);expect(receipt).not.toBeNull();
   await processEvalItemJob(f.repository,f.job,provider,'replay');expect(calls).toHaveBeenCalledOnce();
   expect(await f.repository.getOrFreezeAssessmentReceipt(f.job.projectId,f.job.evalRunId)).toEqual(receipt);
   expect(await f.repository.listAssessmentReceiptArtifacts(f.job.projectId,f.job.evalRunId)).toEqual([receipt]);
   expect(await f.repository.getEvalRun(f.job.projectId,f.job.evalRunId)).toMatchObject({status:'completed',completedItems:1,failedItems:0});
   expect(await f.repository.listVerdicts({projectId:f.job.projectId,limit:10})).toHaveLength(1);
   expect(await f.repository.getEvalRun('foreign-project',f.job.evalRunId)).toBeNull();
   expect(await f.repository.getOrFreezeAssessmentReceipt('foreign-project',f.job.evalRunId)).toBeNull();
  });
  it('rejects a stale owner and records uncertainty without re-dispatching',async()=>{
   const f=await fixture(kind),owner={...f.job,executionToken:'stale'};
   expect(await f.repository.claimEvalRunItemExecution(owner)).toEqual({state:'claimed'});
   expect(await f.repository.beginEvalRunItemProviderCall(owner)).toBe(true);await f.expire(f.job.evalRunItemId);
   expect(await f.repository.completeEvalRunItem({...owner,verdictId:'unowned',resultLabel:'pass'})).toEqual({runFinished:false});
   const provider=createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)),calls=vi.spyOn(provider,'judgeStructured');
   await processEvalItemJob(f.repository,f.job,provider,'replacement');expect(calls).not.toHaveBeenCalled();
   const receipt=(await f.repository.getOrFreezeAssessmentReceipt(f.job.projectId,f.job.evalRunId))!;
   expect(JSON.parse(receipt.canonicalBytes.toString()).items[0].result).toMatchObject({state:'failure',failureKind:'outcome_unknown'});
   expect(await f.repository.getEvalRun(f.job.projectId,f.job.evalRunId)).toMatchObject({status:'failed',completedItems:0,failedItems:1});
  });
 });
}

describe.skipIf(!process.env.PG_SMOKE_DATABASE_URL)('PostgreSQL lease expiry while waiting for an unchanged row lock',()=>{
 it.each(['begin','returned','complete','fail']as const)('rejects %s after the lock wait crosses expiry',async operation=>{
  const f=await fixture('postgres'),owner={...f.job,executionToken:'lock-owner'};
  expect(await f.repository.claimEvalRunItemExecution(owner)).toEqual({state:'claimed'});
  if(operation!=='begin')expect(await f.repository.beginEvalRunItemProviderCall(owner)).toBe(true);
  const result=await f.withExpiringLock!(f.job.evalRunItemId,()=>{
   if(operation==='begin')return f.repository.beginEvalRunItemProviderCall(owner);
   if(operation==='returned')return f.repository.markEvalRunItemProviderCallReturned(owner);
   if(operation==='complete')return f.repository.completeEvalRunItem({...owner,verdictId:'must-never-be-linked',resultLabel:'pass'});
   return f.repository.failEvalRunItem({...owner,error:'expired callback',failure:{state:'failure',failureKind:'outcome_unknown',observed:{model:null,requestId:null,responseId:null,systemFingerprint:null,upstreamProvider:null,thinkingReturned:null,reasoningTokens:null}}});
  });
  expect(result).toEqual(operation==='begin'||operation==='returned'?false:{runFinished:false});
  expect((await f.repository.getEvalRunDetail(f.job.projectId,f.job.evalRunId))?.items[0]?.status).toBe('pending');
 });
});
