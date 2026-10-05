import { createSqliteRuntime } from '../../src/storage/sqlite/runtime.js';
import { MockJudgeProvider } from '@rubrist/audit/runtime';
const [path,encoded,phase]=process.argv.slice(2);
const job=JSON.parse(encoded!);
const forever=()=>new Promise<never>(()=>{});
const runtime=await createSqliteRuntime(path!,()=>Object.assign(new MockJudgeProvider(),{async judge(){
 if(phase==='dispatch'){process.send?.({phase});await forever();}
 return {label:'pass' as const,score:1,confidence:1};
}}));
const command=runtime.storage.command.bind(runtime.storage);
runtime.storage.command=(async(name:string,...args:unknown[])=>{
 if(phase==='finalize'&&name==='finishRegressionAttempt'){process.send?.({phase});await forever();}
 return (command as (...args:any[])=>Promise<any>)(name,...args);
}) as typeof runtime.storage.command;
await runtime.repository.runRegressionGateForVersion(job);
