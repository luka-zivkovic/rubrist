import type { DatabaseSync } from 'node:sqlite';
import type { GovernedReviewRepository } from '../../governed-review/repository.js';
import { GovernedReviewDomainError,GovernedReviewConflictError,GovernedReviewSealedOverlapError } from '../../governed-review/errors.js';
import { sqliteGovernedInstructionCommands } from './governed-instruction-commands.js';
import { sqliteGovernedSubjectCommands } from './governed-subject-commands.js';
import { sqliteGovernedImportedTruthCommands } from './governed-imported-truth-commands.js';
import { sqliteGovernedReadCommands } from './governed-read-commands.js';
import { createGovernedSealedIntake } from './governed-sealed-intake-commands.js';
import { createGovernedDraft } from './governed-draft-commands.js';
import { transitionNonsealedGovernedBatch,getOrCreateNonsealedBlindView } from './governed-view-commands.js';
import { appendNonsealedGovernedTaskAction } from './governed-label-commands.js';
import { appendNonsealedGovernedAlignment } from './governed-alignment-commands.js';
import { appendNonsealedGovernedAdjudication } from './governed-adjudication-commands.js';
import { freezeNonsealedGovernedTruth } from './governed-freeze-commands.js';
type Args<K extends keyof GovernedReviewRepository>=Parameters<GovernedReviewRepository[K]>;
export function sqliteGovernedCommands(db:DatabaseSync){
 const reads=sqliteGovernedReadCommands(db);
 const commands={...sqliteGovernedInstructionCommands(db),...sqliteGovernedSubjectCommands(db),...sqliteGovernedImportedTruthCommands(db),...reads,
  governedSealedIntake:(...args:Args<'createSealedIntake'>)=>createGovernedSealedIntake(db,...args),
  governedDraft:(...args:Args<'createBatchDraft'>)=>reads.governedBatchSummary(args[0],createGovernedDraft(db,...args)),
  governedTransition:(...[actor,batchId,action,command]:Args<'transitionBatch'>)=>{if(action==='freeze')freezeNonsealedGovernedTruth(db,actor,batchId,command);else transitionNonsealedGovernedBatch(db,actor,batchId,action,command);return reads.governedBatchSummary(actor,batchId);},
  governedBlindView:(...args:Args<'getOrCreateBlindTaskView'>)=>getOrCreateNonsealedBlindView(db,...args),
  governedTaskAction:(...args:Args<'appendTaskAction'>)=>appendNonsealedGovernedTaskAction(db,...args),
  governedAlignment:(...args:Args<'appendAlignmentEvent'>)=>appendNonsealedGovernedAlignment(db,...args),
  governedAdjudication:(...args:Args<'appendAdjudication'>)=>appendNonsealedGovernedAdjudication(db,...args)
 };
 // Preserve public domain contracts without sending SQLite SQL/driver fields.
 for(const name of Object.keys(commands) as Array<keyof typeof commands>){
  const command=commands[name] as (...args:any[])=>unknown;
  Object.assign(commands,{[name]:(...args:any[])=>{try{return command(...args);}catch(error){
   if(error instanceof GovernedReviewDomainError)throw error;
   if(error instanceof Error&&typeof (error as {errcode?:unknown}).errcode==='number'&&((error as Error&{errcode:number}).errcode&255)===19){
    if(error.message.includes('overlap')||error.message.includes('sealed successor'))throw new GovernedReviewSealedOverlapError();
    throw new GovernedReviewConflictError('governed_review_transition_conflict','Governed review command conflicts with retained evidence');
   }
   throw error;
  }}});
 }
 return commands;
}
