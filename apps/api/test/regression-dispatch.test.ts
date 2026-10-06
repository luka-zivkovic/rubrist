import { expect, it } from 'vitest';
import { demoProject } from '@rubrist/db';
import { DemoRepository } from '../src/repository.js';
import { runGoldenSetRegression } from '../src/repository/golden-helpers.js';
it('stops new dispatch after a failure and waits for the calls already in flight',async()=>{
 const version=(await new DemoRepository().getCurrentSkill(demoProject.id)).currentVersion;
 const goldenSet=Array.from({length:20},(_,i)=>({id:`golden_${i}`,caseId:`case_${i}`,traceId:`trace_${i}`,agreedLabel:'pass' as const,reason:'Synthetic',promotedBy:'Test',promotedAt:new Date().toISOString(),sourceSkillVersionId:version.id,criterionVersionId:version.criterionVersionId!}));
 const traces=new Map(goldenSet.map(g=>[g.caseId,{id:g.traceId,input:'x',output:'y',metadata:{}}]));
 let calls=0,active=0;let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const run=runGoldenSetRegression({skillVersion:version,goldenSet,traces,judgeProvider:{name:'mock',modelName:'synthetic',async judge(){
  calls++;if(calls===2)throw new Error('Synthetic provider failure');
  active++;await blocked;active--;return {label:'pass',score:1,confidence:1};
 }}});
 let settled=false;const observed=run.then(()=>{settled=true;return null;},error=>{settled=true;return error as Error;});
 await new Promise(resolve=>setTimeout(resolve,0));expect(calls).toBe(4);expect(settled).toBe(false);expect(active).toBe(3);
 release();expect((await observed)?.message).toContain('Synthetic provider failure');expect(active).toBe(0);expect(calls).toBe(4);
});
it('refuses provider dispatch when the attempt has been aborted',async()=>{
 const version=(await new DemoRepository().getCurrentSkill(demoProject.id)).currentVersion;
 const controller=new AbortController();controller.abort(new Error('Lease lost'));let calls=0;
 await expect(runGoldenSetRegression({skillVersion:version,goldenSet:[],traces:new Map(),signal:controller.signal,judgeProvider:{name:'mock',modelName:'synthetic',async judge(){calls++;return {label:'pass',score:1,confidence:1};}}})).rejects.toThrow(/Lease lost/);expect(calls).toBe(0);
});
