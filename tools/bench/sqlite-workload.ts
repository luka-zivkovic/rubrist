// Synthetic, disposable qualification. No provider credentials or existing paths.
import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus,totalmem,platform,release} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {openSqlite} from '../../packages/db/src/sqlite.js';
import {CreateCriterionInputSchema} from '../../packages/shared/src/index.js';
import {createSqliteRuntime} from '../../apps/api/src/storage/sqlite/runtime.js';
import {createStrictJudgeProvider} from '../../apps/api/src/lib/judge-provider.js';
import {processEvalItemJob} from '../../apps/api/src/workers/eval-run.js';
import {MOCK_BINDING,bindingInput} from '../../apps/api/test/fixtures/execution-binding.js';
const count=Number(process.argv[2]??1000),output=process.argv[3];
if(!Number.isInteger(count)||count<100||count>10000||!output)throw Error('Usage: tsx tools/bench/sqlite-workload.ts <100..10000 imports> <new result.json>');
const directory=mkdtempSync(join(tmpdir(),'rubrist-benchmark-')),path=join(directory,'db.sqlite');
process.env.BETTER_AUTH_SECRET=randomUUID()+randomUUID();
let cleanupRuntime:Awaited<ReturnType<typeof createSqliteRuntime>>|undefined;
const timings:Record<string,number[]>={},errors:Record<string,number>={},disk:Array<{elapsedMs:number;database:number;wal:number}>=[];
const beginning=performance.now(),delay=monitorEventLoopDelay({resolution:10});delay.enable();
const bytes=(file:string)=>{try{return statSync(file).size;}catch{return 0;}};
const sample=()=>disk.push({elapsedMs:performance.now()-beginning,database:bytes(path),wal:bytes(path+'-wal')});
const timer=setInterval(sample,25);let finished=0,physicalCalls=0,retained=0;
async function measured<T>(name:string,fn:()=>Promise<T>):Promise<T>{const start=performance.now();try{return await fn();}catch(e){const key=e instanceof Error?e.name:'unknown';errors[key]=(errors[key]??0)+1;throw e;}finally{(timings[name]??=[]).push(performance.now()-start);}}
try{
 const runtime=await createSqliteRuntime(path,undefined,{seedStarterEvaluators:false});cleanupRuntime=runtime;
 const {user}=await runtime.auth.api.signUpEmail({body:{email:'synthetic@example.test',password:randomUUID(),name:'Synthetic operator'}});
 const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
 const r=runtime.repository,criterion=await r.createCriterion(projectId,CreateCriterionInputSchema.parse({stableKey:'benchmark',name:'Synthetic groundedness',definition:'Answers use supplied context.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge {{rubric_markdown}}.',executionBinding:bindingInput(MOCK_BINDING)}}),{});
 const version=criterion.evaluator.currentVersion,caseIds:string[]=[];
 const payload='Synthetic support conversation. '.repeat(128);
 // Eight concurrent import clients through the production worker RPC.
 let cursor=0;
 await Promise.all(Array.from({length:8},async()=>{while(cursor<count){const n=cursor++;const imported=await measured('import',()=>r.importTrace(projectId,'manual',{sourceTraceId:`synthetic-${n}`,input:{question:n,context:payload},output:'A grounded answer.',metadata:{synthetic:true}},{ingestionPurpose:'analysis_eligible_manual'}));caseIds.push(imported.caseId);}}));
 // Respect immutable ingestion time and the production 60-second freeze lag.
 // This explicit maturation wait is reported separately from workload timing.
 await new Promise(resolve=>setTimeout(resolve,65000));
 const windowEnd=new Date(Date.now()-60000).toISOString();delay.reset();
 const reviewIds=caseIds.slice(0,50),evalIds=caseIds.slice(50,150);
 const judgeIds:Record<string,string>={};for(const caseId of reviewIds){const result=await r.recordJudgeRun({projectId,caseId,skillVersionId:version.id,verdict:{label:'pass',score:.9,confidence:.8,reason:'Synthetic review seed'}});judgeIds[caseId]=result.id;}
 const review=await r.createReviewQueue({projectId,name:'Synthetic human review',caseIds:reviewIds,skillVersionId:version.id,judgeRunIds:judgeIds});
 const items=(await r.getReviewQueueDetail(projectId,review.id))!.items;
 const run=await r.createEvalRun({projectId,skillVersionId:version.id,trigger:'manual',items:evalIds.map(caseId=>({caseId}))});
 const provider=createStrictJudgeProvider(version),judge=provider.judgeStructured.bind(provider);
 provider.judgeStructured=async input=>{physicalCalls++;await new Promise(resolve=>setTimeout(resolve,5));return judge(input);};
 await runtime.queue.work<{index:number}>('eval.item',delivery=>measured('evaluation',async()=>{const item=run.items[delivery.data.index]!;await processEvalItemJob(r,{projectId,evalRunId:run.id,evalRunItemId:item.id,caseId:item.caseId,skillVersionId:version.id},provider,delivery.id);finished++;}));
 for(let i=0;i<run.items.length;i++)await runtime.queue.send('eval.item',{index:i},{id:`synthetic-job-${i}`});
 const actor={projectId,userId:user.id,projectRole:'owner' as const};
 // A bounded maintenance writer holds the WAL writer lock for 100 ms.
 // The main thread stays free while the storage worker waits for that lock.
 const blocker=openSqlite(path);let releaseLock:ReturnType<typeof setTimeout>|undefined;
 try{blocker.exec('BEGIN IMMEDIATE');releaseLock=setTimeout(()=>blocker.exec('ROLLBACK'),100);
  await measured('controlledWriterWait',()=>r.importTrace(projectId,'manual',{sourceTraceId:'lock-probe',input:'synthetic',output:'answer',metadata:{}},{ingestionPurpose:'judge_api'}));
 }finally{if(releaseLock)clearTimeout(releaseLock);try{blocker.exec('ROLLBACK');}catch{}blocker.close();}
 const concurrentStart=performance.now();await runtime.queue.start();
 const population=measured('analysisFreeze',()=>runtime.analysisPopulations.createPopulation(actor,{windowStart:'2020-01-01T00:00:00.000Z',windowEnd,fixedBudget:50,idempotencyKey:'synthetic-population'}));
 await Promise.all([
  population,
  (async()=>{for(const item of items)await measured('humanReview',()=>r.recordVerdict({projectId,caseId:item.caseId,skillVersionId:version.id,source:'human',actorUserId:user.id,payload:{kind:'binary',pass:true,rationale:'Synthetic review'},reviewContext:{queueItemId:item.id,judgeRunId:judgeIds[item.caseId]!,submissionId:randomUUID()}}));})(),
  (async()=>{for(let i=0;i<30;i++){await measured('dashboardRead',()=>r.getDashboardSummary(projectId,criterion.criterion.id));await measured('analysisRead',()=>runtime.analysisPopulations.listPopulations(actor,{limit:20,cursor:null}));}})(),
  (async()=>{await population;await r.updateProjectSettings(projectId,{traceRetentionDays:1},{});for(let i=0;i<3;i++){const result=await measured('retention',()=>r.pruneExpiredTraces(projectId,{now:new Date(Date.now()+2*86400000+i*120000)}));retained+=result.skippedImmutableRevisionCases;}})(),
  (async()=>{for(let i=0;i<100;i++)await measured('overlapImport',()=>r.importTrace(projectId,'manual',{sourceTraceId:`overlap-${i}`,input:payload,output:'Answer',metadata:{}},{ingestionPurpose:'analysis_eligible_manual'}));})()
 ]);
 const deadline=Date.now()+120000;while(finished<run.items.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
 if((await population).population.populationSize!==count||retained!==count*3)throw Error('Population/retention conservation failed');
 if(finished!==run.items.length)throw Error(`Queue stalled at ${finished}/${run.items.length}`);
 let durableStates:unknown[]=[];
 do{durableStates=await Promise.all(run.items.map((_,i)=>runtime.queue.getJobState('eval.item',`synthetic-job-${i}`)));if(durableStates.every(state=>state==='completed'))break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
 await runtime.queue.stop();if(durableStates.some(state=>state!=='completed'))throw Error('Queue acknowledgements did not settle durably');
 const terminal=await r.getEvalRun(projectId,run.id);if(terminal?.completedItems!==run.items.length||physicalCalls!==run.items.length)throw Error('Evaluation conservation failed');
 sample();clearInterval(timer);delay.disable();
 const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]??0;
 const metrics=Object.fromEntries(Object.entries(timings).map(([name,values])=>[name,{count:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:Math.max(...values)}]));
 const check=openSqlite(path);let sqliteVersion,lastMigration;try{lastMigration=check.prepare('select id from rubrist_sqlite_migrations order by id desc limit 1').get()!.id;sqliteVersion=check.prepare('select sqlite_version() version').get()!.version;if(check.prepare('pragma integrity_check').get()!.integrity_check!=='ok'||check.prepare('pragma foreign_key_check').all().length)throw Error('Integrity check failed');}finally{check.close();}
 const result={recordedAt:new Date().toISOString(),runtime:{node:process.version,sqlite:sqliteVersion,lastMigration,platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem()},workload:{initialImports:count,maturationWaitMs:65000,overlapImports:100,payloadCharacters:payload.length,importConcurrency:8,evaluations:run.items.length,humanReviews:items.length,populationMembers:(await population).population.populationSize,retentionProtectedRows:retained},elapsedMs:performance.now()-beginning,overlapMs:performance.now()-concurrentStart,jobs:{handlerCompletions:finished,durablyCompleted:durableStates.filter(state=>state==='completed').length,physicalCalls},mainThreadEventLoop:{p50Ms:delay.percentile(50)/1e6,p95Ms:delay.percentile(95)/1e6,maxMs:delay.max/1e6},operations:metrics,errors,disk:{sampledPeakDatabaseBytes:Math.max(...disk.map(x=>x.database)),sampledPeakWalBytes:Math.max(...disk.map(x=>x.wal)),last:disk.at(-1)},limitations:['Single-host synthetic observation, not a capacity guarantee.','Local mock latency 5ms; excludes network/provider costs.','RPC queueing included; no competing unsupported application instance.']};
 writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result,null,2));
}finally{clearInterval(timer);delay.disable();try{await cleanupRuntime?.close();}finally{rmSync(directory,{recursive:true,force:true});}}
