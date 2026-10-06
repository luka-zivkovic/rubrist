import { governedFixture } from './sqlite-governed.js';
import { sqliteGovernedInstructionCommands } from '../../src/storage/sqlite/governed-instruction-commands.js';
import { CreateGovernedReviewBatchInputSchema } from '../../src/governed-review/contracts.js';
export async function governedDraftFixture(){
 const f=await governedFixture(),r=f.runtime.repository,dataset=await r.createDataset({projectId:f.projectId,name:'Governed review'});
 await r.importDatasetExamples({projectId:f.projectId,datasetId:dataset.id,ingestionPurpose:'dataset_example',items:[0,1,2].map(i=>({sourceTraceId:'item-'+i,input:'Question '+i,output:'Answer '+i,metadata:{hidden:'metadata'}}))});
 const revision=(await r.createDatasetRevision({projectId:f.projectId,datasetId:dataset.id,role:'iterative_development'}))!;
 const instruction=sqliteGovernedInstructionCommands(f.db).governedInstructionCreate(f.actor,{criterionVersionId:f.criterionVersionId,title:'Evidence',instructions:'Review independently',failureCodeGuidance:'',idempotencyKey:'instruction'});
 const input=CreateGovernedReviewBatchInputSchema.parse({instructionVersionId:instruction.instructionVersionId,roleIntent:'iterative_development',source:{kind:'dataset_revision',revisionId:revision.id},selection:{method:'simple_random',fixedBudget:1},reviewerUserIds:[f.userId],fixedStopAt:new Date(Date.now()+3600000).toISOString(),idempotencyKey:'draft'});
 return {...f,input,revision};
}
