import { afterEach, expect, it, vi } from 'vitest';
import { DemoRepository } from '../src/repository.js';
import { CapturingQueue } from './app-test-support.js';
import { registerLangSmithPoller } from '../src/workers/langsmith-poller.js';
import { registerLangfusePoller } from '../src/workers/langfuse-poller.js';
import { registerIronsidePoller } from '../src/workers/ironside-poller.js';
import { registerFeedbackSyncWorker } from '../src/workers/feedback-sync.js';
import { registerEvalRunWorkers } from '../src/workers/eval-run.js';
function deferred() { let resolve!:(value:[])=>void; const promise=new Promise<[]>(done=>{resolve=done;});return {promise,resolve}; }
afterEach(()=>vi.useRealTimers());
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
