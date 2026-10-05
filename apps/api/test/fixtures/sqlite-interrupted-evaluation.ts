import { createSqliteRuntime } from '../../src/storage/sqlite/runtime.js';
import { processEvalItemJob } from '../../src/workers/eval-run.js';
import { MockJudgeProvider } from '@rubrist/audit/runtime';
// Dedicated disposable-database child. The parent kills this process only
// after the shared worker has committed its provider-dispatch marker.
const [path,encoded]=process.argv.slice(2);
const runtime=await createSqliteRuntime(path!);
const provider=new MockJudgeProvider();
provider.judgeStructured=async()=> {
  process.send?.({dispatched:true});
  return new Promise(()=>{});
};
await processEvalItemJob(runtime.repository,JSON.parse(encoded!),provider,'interrupted-child');
