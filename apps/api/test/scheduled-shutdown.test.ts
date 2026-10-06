import { afterEach, expect, it, vi } from 'vitest';
import { DemoRepository } from '../src/repository.js';
import { CapturingQueue } from './app-test-support.js';
import { registerLangSmithPoller } from '../src/workers/langsmith-poller.js';
import { registerLangfusePoller } from '../src/workers/langfuse-poller.js';
import { registerIronsidePoller } from '../src/workers/ironside-poller.js';
import { registerFeedbackSyncWorker } from '../src/workers/feedback-sync.js';
import { registerEvalRunWorkers } from '../src/workers/eval-run.js';
import { registerProductionRetentionSweeper } from '../src/production-calibration/retention.js';
import { stopScheduledTasks } from '../src/workers/scheduled-tasks.js';
function deferred() { let resolve!:(value:[])=>void; const promise=new Promise<[]>(done=>{resolve=done;});return {promise,resolve}; }
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it.each([
 ['LangSmith',registerLangSmithPoller,'claimDueLangSmithImportTargets'],
 ['Langfuse',registerLangfusePoller,'claimDueLangfuseImportTargets'],
 ['Ironside',registerIronsidePoller,'claimDueIronsideImportTargets']
] as const)('%s stops future ticks and drains an in-flight import claim',async(_name,register,method)=>{
 vi.useFakeTimers();const repository=new DemoRepository(),queue=new CapturingQueue();
 const work=deferred(),claim=vi.spyOn(repository,method).mockReturnValue(work.promise);
 const handle=register(queue,repository,{intervalMs:100});
 let stopped=false;const shutdown=Promise.resolve(handle.stop()).then(()=>{stopped=true;});
 await vi.advanceTimersByTimeAsync(1000);expect(stopped).toBe(false);expect(claim).toHaveBeenCalledTimes(1);
 work.resolve([]);await shutdown;await vi.advanceTimersByTimeAsync(1000);expect(claim).toHaveBeenCalledTimes(1);
});
it.each(['feedback','evaluation'] as const)('%s recovery drains a running sweep and prevents overlap',async(kind)=>{
 vi.useFakeTimers();const repository=new DemoRepository(),queue=new CapturingQueue(),work=deferred();
 const method=kind==='feedback'?'listSignedOffFeedbackSyncJobs':'listStaleEvalRunItemExecutions';
 const claim=vi.spyOn(repository,method).mockResolvedValueOnce([]).mockReturnValue(work.promise);
 if(kind==='evaluation')vi.spyOn(repository,'listPendingEvalRunItemDispatches').mockResolvedValue([]);
 const handle=kind==='feedback'?await registerFeedbackSyncWorker(queue,repository):await registerEvalRunWorkers(queue,repository);
 await vi.advanceTimersByTimeAsync(60_000);expect(claim).toHaveBeenCalledTimes(2);
 let stopped=false;const shutdown=handle.stop().then(()=>{stopped=true;});
 await vi.advanceTimersByTimeAsync(120_000);expect(stopped).toBe(false);expect(claim).toHaveBeenCalledTimes(2);
 work.resolve([]);await shutdown;await vi.advanceTimersByTimeAsync(120_000);expect(claim).toHaveBeenCalledTimes(2);
});
it.each(['evaluation','retention'] as const)('%s shutdown drains a failing in-flight pass and keeps its failure log',async(kind)=>{
 vi.useFakeTimers();const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
 let fail!:(error:Error)=>void;const failing=()=>new Promise<never>((_,reject)=>{fail=reject;});
 let handle:{stop():Promise<void>},calls:{mock:{calls:unknown[]}};
 if(kind==='evaluation') {
  const repository=new DemoRepository();
  calls=vi.spyOn(repository,'listStaleEvalRunItemExecutions').mockResolvedValueOnce([]).mockImplementation(failing);
  vi.spyOn(repository,'listPendingEvalRunItemDispatches').mockResolvedValue([]);
  handle=await registerEvalRunWorkers(new CapturingQueue(),repository);await vi.advanceTimersByTimeAsync(60_000);
 } else {
  const applyRetention=vi.fn(failing);calls=applyRetention;
  handle=registerProductionRetentionSweeper({applyRetention},{intervalMs:60_000});
 }
 expect(calls.mock.calls).toHaveLength(kind==='evaluation'?2:1);
 const shutdown=handle.stop();fail(new Error('SQLite busy during recovery'));
 await expect(shutdown).resolves.toBeUndefined();
 expect(errors).toHaveBeenCalledWith(...(kind==='evaluation'?['eval.item stale-execution recovery failed:',expect.objectContaining({message:'SQLite busy during recovery'})]:['production record retention failed']));
 await vi.advanceTimersByTimeAsync(180_000);expect(calls.mock.calls).toHaveLength(kind==='evaluation'?2:1);
});
it('stops every scheduled task and reports a failed stop without skipping the others',async()=>{
 const errors=vi.spyOn(console,'error').mockImplementation(()=>{}),drained:string[]=[];
 const failure=new Error('unexpected stop failure');
 const failed=await stopScheduledTasks([
  {stop:async()=>{throw failure;}},
  {stop:()=>{throw failure;}},
  {stop:async()=>{await new Promise(resolve=>setTimeout(resolve,10));drained.push('slow');}},
  {stop:()=>{drained.push('sync');}}
 ]);
 expect(failed).toBe(2);expect(drained.sort()).toEqual(['slow','sync']);
 expect(errors).toHaveBeenCalledTimes(2);expect(errors).toHaveBeenCalledWith('Failed to stop a scheduled Rubrist task:',failure);
});
