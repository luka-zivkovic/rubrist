import { randomUUID } from 'node:crypto';
import type { Trace } from '@rubrist/audit/runtime';
import type { GateRunJob, GoldenSetEntry } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { JudgeProviderUnavailableError, type JudgeProviderFactory } from '../../lib/judge-provider.js';
import { DatasetRevisionConflictError, RegressionGateUnavailableError } from '../../repository/errors.js';
import { previousVerdictsFromRun, runGoldenSetRegression } from '../../repository/golden-helpers.js';
import { gateFailureMessage } from '../../repository.pg/mappers.js';
import type { SqliteStorage } from './client.js';

export function sqliteRegressionService(storage:SqliteStorage,repository:Pick<RubristRepository,'getSkillVersion'|'createSkillVersionPending'|'authorizeSkillVersionExecution'|'getDatasetRevisionDetail'|'getJudgeProviderCredential'>,factory:JudgeProviderFactory):Pick<RubristRepository,'createSkillVersion'|'runRegressionGateForVersion'|'failRegressionGateForVersion'|'getRegressionRunForVersion'|'listRegressionRunsForVersions'> {
 const result=async(job:GateRunJob)=>{
  const version=await repository.getSkillVersion(job.projectId,job.skillVersionId),regressionRun=await storage.command('getRegressionRunForVersion',job.projectId,job.skillVersionId);
  return version&&regressionRun?{version,regressionRun}:null;
 };
 const service:Pick<RubristRepository,'createSkillVersion'|'runRegressionGateForVersion'|'failRegressionGateForVersion'|'getRegressionRunForVersion'|'listRegressionRunsForVersions'>={
  async createSkillVersion(skillId,input,context) {
   const version=await repository.createSkillVersionPending(skillId,input,context);
   if(!version.regressionDatasetRevisionId)throw new DatasetRevisionConflictError('Evaluator has no regression revision');
   return service.runRegressionGateForVersion({projectId:context.projectId,skillVersionId:version.id,datasetRevisionId:version.regressionDatasetRevisionId,overrideReason:input.overrideReason,actorUserId:context.actorUserId,timeScope:input.timeScope});
  },
  getRegressionRunForVersion:(...args)=>storage.command('getRegressionRunForVersion',...args),
  listRegressionRunsForVersions:(...args)=>storage.command('listRegressionRunsForVersions',...args),
  async failRegressionGateForVersion(job,error) {
   if(!await storage.command('failRegressionGate',job,gateFailureMessage(error)))throw new Error('Regression execution is still owned by another live attempt');
  },
  async runRegressionGateForVersion(job) {
   const token=randomUUID(),deadline=Date.now()+10*60_000;
   let claim=await storage.command('claimRegressionAttempt',job,token);
   while(claim.state==='busy'&&Date.now()<deadline) {await new Promise(resolve=>setTimeout(resolve,1000));claim=await storage.command('claimRegressionAttempt',job,token);}
   if(claim.state==='terminal'){const retained=await result(job);if(!retained)throw new Error('Regression result vanished');return retained;}
   if(claim.state!=='claimed')throw new Error('Regression execution is busy');
   const attempt={projectId:job.projectId,skillVersionId:job.skillVersionId,token,epoch:claim.epoch},version=claim.version;
   const controller=new AbortController();
   const heartbeat=setInterval(()=>{void storage.command('touchRegressionAttempt',attempt,false).then(live=>{if(!live)controller.abort(new Error('Regression execution lease lost'));},error=>controller.abort(error));},60_000);heartbeat.unref();
   try {
    await repository.authorizeSkillVersionExecution({projectId:job.projectId,skillVersionId:version.id,context:'candidate_regression_evidence',resourceKind:'regression_revision',resourceId:job.datasetRevisionId,idempotencyKey:`provider-start:candidate-regression:${version.id}:${job.datasetRevisionId}`});
    const revision=await repository.getDatasetRevisionDetail(job.projectId,job.datasetRevisionId);
    if(!revision||revision.role!=='regression_golden')throw new DatasetRevisionConflictError('Pinned regression revision is unavailable');
    const entries:GoldenSetEntry[]=revision.items.map(item=>{
     if(!item.referenceLabel)throw new DatasetRevisionConflictError('Regression item has no reference label');
     return {id:item.sourceGoldenEntryId??item.id,caseId:item.sourceCaseId??item.id,traceId:item.sourceTraceId??item.sourceCaseId??item.id,agreedLabel:item.referenceLabel,reason:item.note??'Frozen regression case.',promotedBy:'Frozen regression revision',promotedAt:item.createdAt,sourceSkillVersionId:version.id,criterionVersionId:version.criterionVersionId!};
    });
    const traces=new Map<string,Trace>(revision.items.map(item=>[item.sourceCaseId??item.id,{id:item.sourceTraceId??item.sourceCaseId??item.id,input:item.payloadSnapshot.input,output:item.payloadSnapshot.output,metadata:item.payloadSnapshot.metadata,...(item.payloadSnapshot.steps?{steps:item.payloadSnapshot.steps}:{})}]));
    const prior=await storage.command('getRegressionPriorRun',job.projectId,version.id);
    const provider=version.executionBinding.provider,key=provider==='mock'?null:await repository.getJudgeProviderCredential(job.projectId,provider);
    const judge=(()=>{try{return factory(version,key?{apiKey:key}:undefined);}catch(error){if(error instanceof JudgeProviderUnavailableError)throw new RegressionGateUnavailableError(provider);throw error;}})();if(provider!=='mock'&&judge.name==='mock')throw new RegressionGateUnavailableError(provider);
    const computed=await runGoldenSetRegression({skillVersion:version,goldenSet:entries,traces,overrideReason:job.overrideReason,actorUserId:job.actorUserId,previousVerdicts:previousVerdictsFromRun(prior),signal:controller.signal,judgeProvider:{name:judge.name,modelName:judge.modelName,async judge(input){
     controller.signal.throwIfAborted();if(!await storage.command('touchRegressionAttempt',attempt,true))throw new Error('Regression execution lease lost before provider dispatch');
     controller.signal.throwIfAborted();return judge.judge(input);
    }}});
    const regressionRun={...computed,datasetRevisionId:job.datasetRevisionId};
    if(!await storage.command('finishRegressionAttempt',attempt,job,regressionRun)) {
     const terminal=await result(job);if(terminal)return terminal;throw new Error('Regression execution lease lost before finalization');
    }
    return (await result(job))!;
   } finally {clearInterval(heartbeat);await storage.command('releaseRegressionAttempt',attempt);}
  }
 };
 return service;
}
