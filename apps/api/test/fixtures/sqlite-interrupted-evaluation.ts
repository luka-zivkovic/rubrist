import {runtimeVersion,MOCK_BINDING} from './execution-binding.js';
import {createStrictJudgeProvider} from '../../src/lib/judge-provider.js';
import { createSqliteRuntime } from '../../src/storage/sqlite/runtime.js';
import { processEvalItemJob } from '../../src/workers/eval-run.js';

// Parent kills only this disposable child after a committed production boundary.
const [path,encoded,phase='dispatched']=process.argv.slice(2);
const runtime=await createSqliteRuntime(path!);
const provider=createStrictJudgeProvider(runtimeVersion(MOCK_BINDING));
let physicalCalls=0;
const judge=provider.judgeStructured.bind(provider);
provider.judgeStructured=async input=>{
 physicalCalls++;
 if(phase==='dispatched'){process.send?.({dispatched:true});return new Promise(()=>{});}
 return judge(input);
};
if(phase==='claimed'){
 const claim=runtime.repository.claimEvalRunItemExecution.bind(runtime.repository);
 runtime.repository.claimEvalRunItemExecution=async input=>{
  const result=await claim(input);
  if(result.state==='claimed'){process.send?.({phase,physicalCalls});await new Promise(()=>{});}
  return result;
 };
}
if(phase==='verdict'){
 const record=runtime.repository.recordVerdict.bind(runtime.repository);
 runtime.repository.recordVerdict=async input=>{
  const verdict=await record(input);process.send?.({phase,physicalCalls});await new Promise(()=>{});return verdict;
 };
}
await processEvalItemJob(runtime.repository,JSON.parse(encoded!),provider,'interrupted-child');
