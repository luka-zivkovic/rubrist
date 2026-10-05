import { CreateCriterionInputSchema } from '@rubrist/shared';
import { fixture } from './sqlite-analysis.js';
import { MOCK_BINDING,bindingInput } from '../fixtures/execution-binding.js';
export async function governedFixture(){
 const f=await fixture(),created=await f.runtime.repository.createCriterion(f.projectId,CreateCriterionInputSchema.parse({stableKey:'review',name:'Evidence',definition:'Answers follow the evidence.',evaluator:{rubricMarkdown:'Pass supported answers',prompt:'Evaluate the answer.',executionBinding:bindingInput(MOCK_BINDING)}}),{actorUserId:f.userId});
 return {...f,criterionVersionId:created.versions[0]!.id,actor:{projectId:f.projectId,userId:f.userId,projectRole:'owner' as const}};
}
