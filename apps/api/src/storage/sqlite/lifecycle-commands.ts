import {transitionLifecycle} from './lifecycle-transition.js';
import type {DatabaseSync} from 'node:sqlite';
import {EvaluatorLifecycleRepositoryError,type EvaluatorLifecycleRepository} from '../../evaluator-lifecycle/repository.js';
import {createLifecycleCandidate} from './lifecycle-candidate.js';
import {loadLifecycleProjection,listLifecycleProjections} from './lifecycle-reads.js';
import {sqliteResolutionCommands} from './resolution-commands.js';
import {sqliteCommand} from './command-context.js';
import {authorizeLifecycleExecution} from './lifecycle-authorization.js';
type Args<K extends keyof EvaluatorLifecycleRepository>=Parameters<EvaluatorLifecycleRepository[K]>;
export function sqliteLifecycleCommands(db:DatabaseSync){
 const resolution=sqliteResolutionCommands(db);
 const commands={
  lifecycleCreate:(...args:Args<'createCandidate'>)=>createLifecycleCandidate(db,...args),
  lifecycleCandidateExists:(...args:Args<'candidateExists'>)=>Boolean(db.prepare('SELECT 1 FROM evaluator_lifecycles WHERE project_id=? AND idempotency_key=?').get(args[0].projectId,args[1])),
  lifecycleGet:(...args:Args<'getLifecycle'>)=>loadLifecycleProjection(db,args[0].projectId,args[1]),
  lifecycleList:(...args:Args<'listLifecycles'>)=>listLifecycleProjections(db,args[0].projectId,args[1]),
  lifecycleBinding:resolution.getGovernedBinding,lifecycleResolution:resolution.recordResolution,
  lifecycleAuthorize:(...args:Args<'authorizeExecution'>)=>sqliteCommand(db,c=>authorizeLifecycleExecution(c,...args)),
  lifecycleActivate:(...args:Args<'activate'>)=>transitionLifecycle(db,...args,'activated'),
  lifecycleRetire:(...args:Args<'retire'>)=>transitionLifecycle(db,...args,'retired')
 };
 for(const name of Object.keys(commands) as Array<keyof typeof commands>){const command=commands[name] as (...args:any[])=>unknown;Object.assign(commands,{[name]:(...args:any[])=>{try{return command(...args);}catch(error){
  if(error instanceof EvaluatorLifecycleRepositoryError)throw error;
  const e=error as {errcode?:number;message?:string};
  if(((e.errcode??0)&255)===19)throw new EvaluatorLifecycleRepositoryError(e.message?.includes('UNIQUE')?'idempotency_conflict':'state_conflict','Evaluator lifecycle command conflicts with retained evidence');
  throw error;
 }}});}
 return commands;
}
